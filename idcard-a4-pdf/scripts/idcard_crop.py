#!/usr/bin/env python3
"""idcard_crop.py — 证件照片裁切 + 透视校正 + A4 PDF 排版

用法:
    python3 idcard_crop.py <输出.pdf> <图片1> [图片2] [--export-png] [--dpi 300]
                    [--name 姓名] [--auto-name] [--no-trim-frame]

流程(纯本地, 不依赖视觉模型):
  1. 色调分割: 桌面/背景通常暖色(R-B≈10..18), 证件卡片冷色(B-R>=0)
     -> 掩膜 = (B - R > -5)。对光照渐变不敏感。
  2. 连通域(下采样 BFS) -> 候选打分:
     纵横比≈1.585(身份证比例) + 矩形填充率 + 位于图内 + 面积。
     背景杂乱时也不会被"最大的冷色物体"带偏, 除非它也符合卡片形状先验。
  3. 边线稳健拟合(剔除离群点) -> 四角 -> QUAD 双线性校正
     (注意 PIL 角点顺序是 NW,SW,SE,NE) -> 1.585 标准矩形。
  4. 往返验证: 逆变换把校正图像素映射回原图, 输出置信度。
  5. A4(210x297mm @dpi) 排版, 卡片真实尺寸 85.6x54mm, 上下排列(正面在上)。
  6. 姓名提取(--auto-name): 从正面卡片模板区域 OCR 提取姓名, 输出命名 "<姓名>身份证.pdf";
     可用 --name 显式指定(视觉模型读姓名后传入, 比 OCR 更可靠)。
"""
import sys, os, math, argparse
from PIL import Image, ImageOps

ID_ASPECT = 85.6 / 54.0  # 1.585


def open_image(path):
    """打开图片: RGB + 应用 EXIF 方向(手机照片常带 orientation 标签)。"""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def build_hue_mask(img, thresh=-5):
    """掩膜: 冷色调像素(B-R > thresh)。桌面暖、卡片冷。"""
    w, h = img.size
    px = img.load()
    m = Image.new("1", (w, h), 0)
    mp = m.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if b - r > thresh:
                mp[x, y] = 1
    return m


def collect_components(mask):
    """下采样 2 倍 BFS, 返回全部白色连通块: [(area, x0, y0, x1, y1)] 全分辨率(排他)。"""
    w, h = mask.size
    sw, sh = w // 2, h // 2
    small = mask.resize((sw, sh))
    sp = small.load()
    visited = [[False] * sw for _ in range(sh)]
    comps = []
    for sy in range(sh):
        for sx in range(sw):
            if not sp[sx, sy] or visited[sy][sx]:
                continue
            area = 0
            x0 = y0 = 1 << 30
            x1 = y1 = -1
            stack = [(sx, sy)]
            visited[sy][sx] = True
            while stack:
                cx, cy = stack.pop()
                area += 1
                if cx < x0: x0 = cx
                if cx > x1: x1 = cx
                if cy < y0: y0 = cy
                if cy > y1: y1 = cy
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < sw and 0 <= ny < sh and not visited[ny][nx] and sp[nx, ny]:
                        visited[ny][nx] = True
                        stack.append((nx, ny))
            comps.append((area, x0 * 2, y0 * 2, (x1 + 1) * 2, (y1 + 1) * 2))
    return comps


def score_component(c, W, H):
    """候选打分: 越像"平放在桌面上的身份证"得分越高。"""
    area, x0, y0, x1, y1 = c
    bw, bh = x1 - x0, y1 - y0
    if bw < 60 or bh < 45:
        return -1e9
    aspect = bw / bh
    aspect_score = math.exp(-abs(math.log(aspect / ID_ASPECT)) / 0.35)
    rect = (area * 4) / (bw * bh)                # 矩形填充率(BFS在下采样图, 面积×4还原)
    m = 0.02 * min(W, H)                         # 距边缘 2% 视为"位于图内"
    inner_w = max(0, min(x1, W - m) - max(x0, m))
    inner_h = max(0, min(y1, H - m) - max(y0, m))
    interior = (inner_w * inner_h) / (bw * bh)
    size = min(area / (W * H) / 0.18, 1.0)       # 卡片通常占画面 10%~40%
    return 0.35 * aspect_score + 0.25 * rect + 0.20 * interior + 0.20 * size


def fit_robust(xs, ys, max_iter=4):
    """稳健线性拟合: 迭代剔除残差 > 3*中位数(下限4px) 的离群点。返回 (a, b, med_res, n)。"""
    pts = list(zip(xs, ys))
    if len(pts) < 4:
        return None
    for _ in range(max_iter):
        n = len(pts)
        sx = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
        sxx = sum(p[0] * p[0] for p in pts); sxy = sum(p[0] * p[1] for p in pts)
        denom = n * sxx - sx * sx
        if denom == 0:
            break
        b = (n * sxy - sx * sy) / denom
        a = (sy - b * sx) / n
        res = sorted(abs(p[1] - (a + b * p[0])) for p in pts)
        med = res[len(res) // 2]
        th = max(med * 3, 4.0)
        keep = [p for p in pts if abs(p[1] - (a + b * p[0])) <= th]
        if len(keep) == n:
            return (a, b, med, n)
        pts = keep
    n = len(pts)
    if n < 4:
        return None
    sx = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
    sxx = sum(p[0] * p[0] for p in pts); sxy = sum(p[0] * p[1] for p in pts)
    b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    a = (sy - b * sx) / n
    return (a, b, 0.0, n)


def intersect(lineX, lineY):
    """lineX: x = a + b*y ; lineY: y = a + b*x -> (x, y)"""
    a1, b1 = lineX
    a2, b2 = lineY
    x = (a1 + b1 * a2) / (1 - b1 * b2)
    return (x, a2 + b2 * x)


def iou(a, b):
    """两个 bbox 的 IoU。"""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    if inter == 0:
        return 0.0
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / ua


def fit_card_geometry(img, mask, bbox):
    """对候选块做四边稳健拟合 -> (corners, Wout, Hout, info) 或 None。"""
    x0, y0, x1, y1 = bbox
    mp = mask.load()
    rows = {}
    for y in range(y0 + 8, y1 - 8, 2):
        xs = [x for x in range(x0, x1) if mp[x, y]]
        if len(xs) > (x1 - x0) * 0.35:
            rows[y] = (min(xs), max(xs))
    cols = {}
    for x in range(x0 + 8, x1 - 8, 2):
        ys = [y for y in range(y0, y1) if mp[x, y]]
        if len(ys) > (y1 - y0) * 0.35:
            cols[x] = (min(ys), max(ys))
    L = fit_robust(list(rows), [rows[y][0] for y in rows])   # x = a + b*y
    R = fit_robust(list(rows), [rows[y][1] for y in rows])
    T = fit_robust(list(cols), [cols[x][0] for x in cols])   # y = a + b*x
    B = fit_robust(list(cols), [cols[x][1] for x in cols])
    if not (L and R and T and B):
        return None
    TL = intersect((L[0], L[1]), (T[0], T[1]))
    TR = intersect((R[0], R[1]), (T[0], T[1]))
    BL = intersect((L[0], L[1]), (B[0], B[1]))
    BR = intersect((R[0], R[1]), (B[0], B[1]))
    tl = math.hypot(TR[0] - TL[0], TR[1] - TL[1]); bl = math.hypot(BR[0] - BL[0], BR[1] - BL[1])
    ll = math.hypot(BL[0] - TL[0], BL[1] - TL[1]); rl = math.hypot(BR[0] - TR[0], BR[1] - TR[1])
    info = {"corners": tuple(tuple(round(v) for v in p) for p in (TL, TR, BR, BL)),
            "edge_len": {"top": round(tl), "bottom": round(bl), "left": round(ll), "right": round(rl)}}
    if not (min(tl, bl, ll, rl) > 100 and 0.4 < ll / max(rl, 1) < 2.5 and 0.4 < tl / max(bl, 1) < 2.5):
        info["warn"] = "四边形边长异常, 透视校正结果可能失真"
    Wout = round((tl + bl) / 2)
    Hout = round(Wout / ID_ASPECT)
    return (TL, TR, BR, BL), Wout, Hout, info


def detect_cards_from_image(img, max_cards=2):
    """在一张图中检测 1~2 张卡片。返回 [(corners, Wout, Hout, info), ...] 或 []。

    支持: 单卡照片(冷色卡/暖色桌)、蓝调卡面(mockup/扫描件, 正阈值)、单图多卡(上下/左右)。
    硬性门槛: 候选 bbox 纵横比须在 [0.9, 2.4] (拒绝整图当卡片)。
    """
    W, H = img.size
    thresholds = (-5, 0, -10, 4, 8)
    cands = []
    for thresh in thresholds:
        mask = build_hue_mask(img, thresh)
        for c in collect_components(mask):
            s = score_component(c, W, H)
            if s <= 0.35:
                continue
            area, x0, y0, x1, y1 = c
            aspect = (x1 - x0) / (y1 - y0)
            if not (0.5 <= aspect <= 3.0):       # 宽松预筛, 允许被拆成两半的卡
                continue
            if (x1 - x0) * (y1 - y0) < 0.005 * W * H:   # 尺寸下限: 拒绝卡片内部小碎块
                continue
            if min(x1 - x0, y1 - y0) < max(90, int(0.06 * min(W, H))):   # 绝对最小边长: 拒绝桌面污渍等小块
                continue
            cands.append((s, thresh, (x0, y0, x1, y1)))
    if not cands:
        return []
    # 去重: 同一卡片被不同阈值/块找到 (IoU>0.5 归并, 保留高分)
    cands.sort(reverse=True)
    kept = []
    for s, th, c in cands:
        if not any(iou(k[2], c) > 0.5 for k in kept):
            kept.append((s, th, c))
    # 合并"被内部特征(照片/色带)拆成左右两半"的卡片
    merged, used = [], set()
    for i in range(len(kept)):
        if i in used:
            continue
        box, box_s = kept[i][2], kept[i][0]
        for j in range(i + 1, len(kept)):
            if j in used:
                continue
            b2, s2 = kept[j][2], kept[j][0]
            oy = min(box[3], b2[3]) - max(box[1], b2[1])
            if oy <= 0:
                continue
            if oy < 0.6 * min(box[3] - box[1], b2[3] - b2[1]):
                continue
            left, right = (box, b2) if box[0] < b2[0] else (b2, box)
            gap = right[0] - left[2]
            if gap < 0 or gap > 0.2 * (right[2] - left[0]):
                continue
            uni = (left[0], min(left[1], right[1]), right[2], max(left[3], right[3]))
            if 1.2 <= (uni[2] - uni[0]) / (uni[3] - uni[1]) <= 2.2:
                box, box_s = uni, max(box_s, s2)
                used.add(j)
        merged.append((box_s, box))
        used.add(i)
    # 合并后再去重(IoU>0.5, 保留高分): 整卡与"半卡合并"常指向同一张卡
    merged.sort(reverse=True)
    dedup = []
    for s, b in merged:
        if not any(iou(d[1], b) > 0.5 for d in dedup):
            dedup.append((s, b))
    merged = dedup
    # 最终纵横比过滤(拒绝整图当卡片)
    merged = [m for m in merged if 0.9 <= (m[1][2] - m[1][0]) / (m[1][3] - m[1][1]) <= 2.4]
    # 包含关系剔除: 大候选内的"小块"是卡片内部特征, 不是第二张卡
    merged.sort(reverse=True)
    finals = []
    for s, b in merged:
        contained = False
        for s2, b2 in finals:
            ax0, ay0, ax1, ay1 = b
            bx0, by0, bx1, by1 = b2
            if ax0 >= bx0 and ay0 >= by0 and ax1 <= bx1 and ay1 <= by1:
                if (ax1 - ax0) * (ay1 - ay0) < 0.5 * (bx1 - bx0) * (by1 - by0):
                    contained = True
                    break
        if not contained:
            finals.append((s, b))
    # 按得分降序取前 max_cards; 得分相同时上面的卡在前
    finals.sort(key=lambda m: (-m[0], (m[1][1] + m[1][3]) / 2))
    results = []
    for idx, (s, bbox) in enumerate(finals):
        if idx >= max_cards:
            break
        x0, y0, x1, y1 = bbox
        aspect = (x1 - x0) / (y1 - y0)
        if idx > 0 and finals:
            top_area = (finals[0][1][2] - finals[0][1][0]) * (finals[0][1][3] - finals[0][1][1])
            area = (x1 - x0) * (y1 - y0)
            # 第二张卡必须是"真卡"尺度: 面积够大且比例接近标准证(排除阴影/碎块)
            if area < 0.25 * top_area or not (1.25 <= aspect <= 1.95):
                continue
        geom = None
        for thresh in thresholds:
            mask = build_hue_mask(img, thresh)
            geom = fit_card_geometry(img, mask, bbox)
            if geom:
                break
        if geom:
            corners, Wout, Hout, info = geom
            info.update({"bbox": bbox, "bbox_aspect": round(aspect, 3), "score": round(s, 3)})
            results.append((corners, Wout, Hout, info))
    return results


def _edges_touched(bbox, W, H, margin=3):
    """bbox 贴住图像边缘的边数(0-4)。"""
    x0, y0, x1, y1 = bbox
    n = 0
    if x0 <= margin: n += 1
    if y0 <= margin: n += 1
    if x1 >= W - margin: n += 1
    if y1 >= H - margin: n += 1
    return n


def detect_cards(path, max_cards=2, try_rotate=True):
    """按路径检测 1~2 张卡片, 返回 (dets, img)。

    竖拍/旋转处理(仅两种情况):
      1) 首遍检测为空 -> 尝试 ±90° 旋转(卡片横竖颠倒)
      2) 竖图(宽<高)且候选贴住 >=3 条边 -> 疑似"整卡旋转90°后被切出的片",
         与旋转结果按首卡得分竞争, 取更优
    正常竖图照片(卡片未贴边)不启动旋转, 避免把正常卡片误判为旋转。
    """
    img = open_image(path)
    dets = detect_cards_from_image(img, max_cards)
    W, H = img.size
    need_rotation = not dets
    if dets and try_rotate and W < H and _edges_touched(dets[0][3]["bbox"], W, H) >= 3:
        need_rotation = True
    if try_rotate and need_rotation:
        for deg in (90, -90):
            rimg = img.rotate(-deg, expand=True)
            rdets = detect_cards_from_image(rimg, max_cards)
            if not rdets:
                continue
            for d in rdets:
                d[3]["rotated"] = deg
            if not dets or rdets[0][3].get("score", 0) > dets[0][3].get("score", 0):
                dets = rdets
                img = rimg
    return dets, img


def detect_card(path):
    """单卡模式(兼容入口): 返回 (corners, W, H, info) 或 (None, None, None, info)。"""
    dets, _ = detect_cards(path, max_cards=1)
    info = {}
    if not dets:
        info["error"] = ("未检测到证件卡片。常见原因: 背景有大块蓝/绿色物体且与卡片粘连、"
                         "卡片被遮挡、卡片边缘与背景同色、或输入不是证件照片。"
                         "建议重拍: 卡片完整入镜、背景无大块冷色物体。")
        return None, None, None, info
    return dets[0]


def warp_card(img, corners, Wout, Hout, info):
    """QUAD 双线性校正(角点顺序 NW,SW,SE,NE = TL,BL,BR,TR)。"""
    TL, TR, BR, BL = corners
    quad = [TL[0], TL[1], BL[0], BL[1], BR[0], BR[1], TR[0], TR[1]]
    card = img.transform((Wout, Hout), Image.Transform.QUAD, quad,
                         resample=Image.BICUBIC, fillcolor=(255, 255, 255))
    info["warp_size"] = (Wout, Hout)
    return card


def verify_warp(src, warp, corners, Wout, Hout, step=24):
    """往返验证: 校正图像素逆映射回原图, 返回误差<=12灰度级的占比(%)。"""
    sp = src.convert("L").load()
    wp = warp.convert("L").load()
    sw, sh = src.size
    TL, TR, BR, BL = corners
    diffs = []
    for wy in range(0, Hout, step):
        for wx in range(0, Wout, step):
            u = wx / Wout; v = wy / Hout
            x = TL[0] * (1 - u) * (1 - v) + TR[0] * u * (1 - v) + BR[0] * u * v + BL[0] * (1 - u) * v
            y = TL[1] * (1 - u) * (1 - v) + TR[1] * u * (1 - v) + BR[1] * u * v + BL[1] * (1 - u) * v
            xi, yi = round(x), round(y)
            if 0 <= xi < sw and 0 <= yi < sh:
                diffs.append(abs(sp[xi, yi] - wp[wx, wy]))
    if not diffs:
        return 0.0
    ok = sum(1 for d in diffs if d <= 12)
    return ok / len(diffs) * 100.0


def border_foreign_ratio(card, strip=6, sat_th=70, hue_th=60):
    """输出边缘强饱和像素占比(蓝或暖): 检测透视校正后是否混入背景物体(粘连/覆盖)。

    卡片自身底纹饱和度 <50; 蓝/绿/红/橙等背景物体饱和度通常 >70 且色调明显偏移,
    与卡片白底反差大 -> 视为异物。
    """
    w, h = card.size
    px = card.convert("RGB").load()
    bad = tot = 0
    for y in range(h):
        for x in range(w):
            if x < strip or y < strip or x >= w - strip or y >= h - strip:
                r, g, b = px[x, y]
                tot += 1
                if max(r, g, b) - min(r, g, b) > sat_th and abs(b - r) > hue_th:
                    bad += 1
    return bad / max(tot, 1) * 100.0


def trim_dark_frame(img, cap_frac=0.05, buffer=2):
    """裁掉卡片四周的深色边框(扫描/裁切残留)。

    相对阈值: 边框比卡片内部亮度低 60 才裁, 保护正常卡片的深色底纹边缘。
    返回 (裁切图, (上,下,左,右) 边框宽度); 无边框时原样返回。
    """
    w, h = img.size
    gray = img.convert("L").load()
    cx0, cy0, cx1, cy1 = int(w * 0.2), int(h * 0.2), int(w * 0.8), int(h * 0.8)
    vals = [gray[x, y] for y in range(cy0, cy1, 6) for x in range(cx0, cx1, 6)]
    vals.sort()
    interior = vals[len(vals) // 2]
    thresh = interior - 60
    cap_w, cap_h = int(w * cap_frac), int(h * cap_frac)

    def side(axis, reverse):
        res = []
        if axis == 0:
            for y in range(0, h, 4):
                rng = range(w - 1, -1, -1) if reverse else range(w)
                for x in rng:
                    if gray[x, y] > thresh:
                        res.append(w - 1 - x if reverse else x)
                        break
        else:
            for x in range(0, w, 4):
                rng = range(h - 1, -1, -1) if reverse else range(h)
                for y in rng:
                    if gray[x, y] > thresh:
                        res.append(h - 1 - y if reverse else y)
                        break
        res.sort()
        return min(res[len(res) // 2], cap_w if axis == 0 else cap_h)

    t, b = side(1, False), side(1, True)
    l, r = side(0, False), side(0, True)
    if max(t, b, l, r) < 2:
        return img, (0, 0, 0, 0)
    t2, b2, l2, r2 = t + buffer, b + buffer, l + buffer, r + buffer
    return img.crop((l2, t2, w - r2, h - b2)), (t2, b2, l2, r2)


def extract_name(card_img):
    """从正面卡片提取姓名(2-4个汉字)。

    方法: 紧模板区域 OCR —— 二代证"姓名"值位于卡片固定相对位置(0.15-0.35 x, 0.08-0.22 y)。
    适合标准二代证版式(真实证件); 非标准版式(网页模板等)可能误读, 此时应用 --name 显式指定。
    黑名单拒绝背面标题/证件字样。两模式(psm7/psm6)结果一致才采信, 避免单次OCR噪声。
    """
    import shutil, subprocess, re, tempfile
    if shutil.which("tesseract") is None:
        return None

    def ocr(png_path, psm):
        try:
            return subprocess.run(
                ["tesseract", png_path, "-", "-l", "chi_sim", "--psm", str(psm)],
                capture_output=True, text=True, timeout=90).stdout
        except Exception:
            return ""

    def cjk(s):
        m = re.findall(r"[\u4e00-\u9fff]{2,4}", s.replace(" ", "").replace("\n", ""))
        return m[0] if m else None

    def agree(a, b):
        return a == b or (len(a) == len(b) and sum(1 for x, y in zip(a, b) if x != y) <= 1)

    def plausible(n):
        return not any(b in n for b in ("中华", "人民", "共和", "居民", "身份", "证明", "国徽", "证件"))

    w, h = card_img.size
    crop = card_img.crop((int(w * 0.15), int(h * 0.08), int(w * 0.35), int(h * 0.22)))
    crop = crop.resize((crop.size[0] * 2, crop.size[1] * 2), Image.LANCZOS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        tmp = f.name
    try:
        crop.save(tmp)
        n1 = cjk(ocr(tmp, 7))
        n2 = cjk(ocr(tmp, 6))
    finally:
        os.unlink(tmp)
    if n1 and not plausible(n1):
        n1 = None
    if n2 and not plausible(n2):
        n2 = None
    if n1 and n2 and agree(n1, n2):
        return n1
    if n1 and not n2:
        return n1
    return None


def compose_a4(cards, out_pdf, dpi):
    """卡片真实尺寸(85.6x54mm)排版到 A4: 1张居中, 2张上下排列(第一张在上、第二张在下)。"""
    PAGE_W = round(210 / 25.4 * dpi); PAGE_H = round(297 / 25.4 * dpi)
    CARD_W = round(85.6 / 25.4 * dpi); CARD_H = round(54 / 25.4 * dpi)
    page = Image.new("RGB", (PAGE_W, PAGE_H), (255, 255, 255))
    resized = [c.convert("RGB").resize((CARD_W, CARD_H), Image.LANCZOS) for c in cards]
    x = (PAGE_W - CARD_W) // 2
    if len(resized) == 2:
        gap = round(15 / 25.4 * dpi)
        total_h = CARD_H * 2 + gap
        ys = [(PAGE_H - total_h) // 2, (PAGE_H - total_h) // 2 + CARD_H + gap]
    else:
        ys = [(PAGE_H - CARD_H) // 2]
    BORDER = 3
    for img, y in zip(resized, ys):
        page.paste((204, 204, 204), (x - BORDER, y - BORDER, x + CARD_W + BORDER, y + CARD_H + BORDER))
        page.paste(img, (x, y))
    page.save(out_pdf, "PDF", resolution=dpi)
    return out_pdf, page.size


def main():
    ap = argparse.ArgumentParser(description="证件照片裁切+透视校正+A4 PDF")
    ap.add_argument("out", help="输出 PDF 路径")
    ap.add_argument("images", nargs="+", help="1~2 张证件照片")
    ap.add_argument("--export-png", action="store_true", help="同时导出单张证件 PNG")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--name", help="显式指定持证姓名(视觉模型读出后传入, 比 OCR 可靠)")
    ap.add_argument("--auto-name", action="store_true",
                    help="自动提取姓名并把输出命名为 <姓名>身份证.pdf")
    ap.add_argument("--no-trim-frame", action="store_true",
                    help="不裁切卡片四周深色边框(扫描/裁切残留); 默认自动裁")
    args = ap.parse_args()
    if len(args.images) > 2:
        print("错误: 最多支持 2 张图片"); sys.exit(2)

    cards, ok_all = [], True
    name = args.name or None
    front_done = False
    for i, p in enumerate(args.images):
        print("=" * 60)
        print(f"[{i + 1}/{len(args.images)}] {p}")
        try:
            img = open_image(p)
        except Exception as e:
            print(f"  无法打开图片: {e}"); ok_all = False; continue
        max_cards = 2 if i == 0 else 1
        dets, img = detect_cards(p, max_cards=max_cards)
        if not dets:
            print("  FAILED: 未检测到证件卡片。常见原因: 背景有大块蓝/绿色物体且与卡片粘连、"
                  "卡片被遮挡、卡片边缘与背景同色、或输入不是证件照片。建议重拍。")
            ok_all = False
            continue
        if any("rotated" in d[3] for d in dets):
            print(f"  检测到卡片竖拍/旋转, 已自动旋转校正")
        if len(dets) > 1:
            print(f"  检测到 {len(dets)} 张卡片(单图多卡), 按上下顺序作为正/背面")
        for det in dets:
            corners, Wout, Hout, info = det
            print(f"  卡片 @ bbox={info['bbox']} 纵横比={info['bbox_aspect']} "
                  f"四角={info['corners']} 边长={info['edge_len']}")
            if "warn" in info:
                print(f"  WARN: {info['warn']}")
            card = warp_card(img, corners, Wout, Hout, info)
            conf = verify_warp(img, card, corners, Wout, Hout)
            print(f"  透视校正 {info['warp_size']}, 往返验证 {conf:.0f}% 像素一致"
                  f"({'OK' if conf >= 80 else '偏低'})")
            if conf < 80:
                ok_all = False
                print("  WARN: 验证置信度低, 结果可能不可靠")
            if not args.no_trim_frame:
                card, box = trim_dark_frame(card)
                if box != (0, 0, 0, 0):
                    print(f"  裁掉暗框: 上{box[0]} 下{box[1]} 左{box[2]} 右{box[3]}px")
            br = border_foreign_ratio(card)
            if br > 1.0:
                ok_all = False
                print(f"  FAILED: 输出边缘检测到 {br:.0f}% 强饱和(蓝/暖色)像素, 疑似背景物体与卡片粘连/覆盖, "
                      f"已排除该图。建议重拍: 卡片完整入镜、背景无蓝/绿/红等鲜艳物体。")
                continue
            cards.append(card)
            if not front_done and name is None and args.auto_name:
                name = extract_name(card)
                if name:
                    print(f"  OCR 识别姓名: {name}")
                else:
                    print("  未能可靠识别姓名(OCR 结果不一致或失败), 将使用默认文件名")
                front_done = True
        if args.export_png and dets:
            base = os.path.splitext(os.path.basename(p))[0]
            for k, det in enumerate(dets):
                c2 = warp_card(img, det[0], det[1], det[2], det[3])
                suf = "" if len(dets) == 1 else f"_{k + 1}"
                c2.save(os.path.join(os.path.dirname(args.out) or ".", f"{base}{suf}_card.png"))
            print(f"  已导出: {base}[_1/_2]_card.png")

    if not cards:
        print("\n全部图片检测失败, 未生成 PDF"); sys.exit(1)
    out_path = args.out
    if args.auto_name and name:
        out_path = os.path.join(os.path.dirname(args.out) or ".", f"{name}身份证.pdf")
    out, page_size = compose_a4(cards, out_path, args.dpi)
    print("=" * 60)
    print(f"PDF 已生成: {out}  (A4 @{args.dpi}dpi, 页面 {page_size})")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
