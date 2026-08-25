window.__ModuleLoader__.load({
  id: 'dsh-network-proxy',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-runtime/client')

    const NS = 'settings.networkProxy'
    const SETTINGS_NS = 'network-proxy'
    const styles = `
      .dshNetworkProxyRow{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:14px;padding:16px 0}
      .dshNetworkProxyHeader{display:flex;align-items:flex-start;gap:24px}
      .dshNetworkProxyCopy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}
      .dshNetworkProxyTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
      .dshNetworkProxyDesc,.dshNetworkProxyStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .dshNetworkProxyStatus[data-error=true]{color:var(--dsw-alias-state-error-primary)}
      .dshNetworkProxyModes{display:grid;grid-template-columns:repeat(3,minmax(72px,1fr));flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px;background:var(--dsw-alias-bg-module-platform)}
      .dshNetworkProxyMode{height:30px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
      .dshNetworkProxyMode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dshNetworkProxyMode[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
      .dshNetworkProxyMode:disabled{cursor:default;opacity:.6}
      .dshNetworkProxyManual{display:flex;align-items:center;gap:8px;padding-left:0}
      .dshNetworkProxyInput{box-sizing:border-box;flex:1;min-width:0;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-input);color:var(--dsw-alias-label-primary);padding:0 11px;font:inherit;font-size:13px;outline:none}
      .dshNetworkProxyInput:focus{border-color:var(--dsw-alias-border-primary)}
      .dshNetworkProxyApply{height:36px;border:0;border-radius:8px;padding:0 14px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-primary);font:inherit;font-size:13px;cursor:pointer}
      .dshNetworkProxyApply:disabled{cursor:default;opacity:.55}
      @media(max-width:680px){.dshNetworkProxyHeader{flex-direction:column;gap:12px}.dshNetworkProxyModes{width:100%}.dshNetworkProxyManual{align-items:stretch;flex-direction:column}.dshNetworkProxyApply{align-self:flex-end}}
    `

    function ensureStyles() {
      if (document.querySelector('style[data-plugin-css="dsh-network-proxy"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-network-proxy'
      tag.dataset.pluginCss = 'dsh-network-proxy'
      tag.textContent = styles
      document.head.appendChild(tag)
    }

    const zh = {
      title: '网络代理',
      description: '配置 DeepSeek Harness 访问网络的方式，修改后立即生效',
      system: '跟随系统',
      manual: '手动代理',
      direct: '直连',
      placeholder: 'http://127.0.0.1:7890',
      apply: '应用',
      saving: '正在应用...',
      ready: '已生效',
      unavailable: '网络代理设置不可用',
    }
    const en = {
      title: 'Network proxy',
      description: 'Configure how DeepSeek Harness accesses the network; changes apply immediately',
      system: 'Follow system',
      manual: 'Manual proxy',
      direct: 'Direct',
      placeholder: 'http://127.0.0.1:7890',
      apply: 'Apply',
      saving: 'Applying...',
      ready: 'Active',
      unavailable: 'Network proxy settings are unavailable',
    }

    class NetworkProxyController {
      constructor(api) {
        this.api = api
        this.view = undefined
        this.generation = 0
        this.store = createSnapshotStore({
          status: 'idle',
          error: null,
          writable: false,
          mode: 'system',
          url: '',
          revision: 0,
        })
      }

      async load() {
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        try {
          const response = await this.api.settings.describe({})
          if (!response.result.ok) throw new Error(response.result.error.message)
          if (generation !== this.generation) return
          const view = response.result.value.namespaces.find((entry) => entry.ns === SETTINGS_NS)
          if (!view) {
            this.view = undefined
            this.store.update((state) => { state.status = 'unavailable'; state.writable = false })
            return
          }
          this.accept(view, response.result.value.writable)
        } catch (error) {
          if (generation !== this.generation) return
          this.fail(error)
        }
      }

      async save(patch) {
        if (!this.view || !this.store.getSnapshot().writable) return
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'saving'; state.error = null })
        try {
          const ops = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
          const response = await this.api.settings.mutate({
            ns: SETTINGS_NS,
            ops,
            expectedRevision: this.view.revision,
          })
          if (generation !== this.generation) return
          if (!response.result.ok) throw new Error(response.result.error.message)
          this.accept(response.result.value, true)
        } catch (error) {
          if (generation !== this.generation) return
          this.fail(error)
        }
      }

      accept(view, writable) {
        const value = view.value || {}
        this.view = view
        this.store.update((state) => {
          state.status = 'ready'
          state.error = null
          state.writable = writable
          state.mode = typeof value.mode === 'string' ? value.mode : 'system'
          state.url = typeof value.url === 'string' ? value.url : ''
          state.revision = view.revision
        })
      }

      fail(error) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
        })
      }

      dispose() { this.generation += 1; this.view = undefined }
    }

    function NetworkProxyRow({ controller, useProxy, t }) {
      const state = useProxy((snapshot) => snapshot)
      const [url, setUrl] = React.useState(state.url)
      const [draftManual, setDraftManual] = React.useState(false)
      React.useEffect(() => { controller.load() }, [controller])
      React.useEffect(() => { setUrl(state.url) }, [state.url])
      // A draft only exists while the user is about to type a URL; once the
      // server confirms manual mode it becomes redundant.
      React.useEffect(() => {
        if (state.status === 'ready' && state.mode === 'manual') setDraftManual(false)
      }, [state.status, state.mode])
      if (state.status === 'unavailable') return null
      const busy = state.status === 'loading' || state.status === 'saving'
      const disabled = busy || !state.writable
      const choose = (mode) => {
        if (mode === state.mode || disabled) return
        if (mode === 'manual' && !state.url) {
          // Switching to manual with no URL yet: show the URL input instead of
          // saving a mode the server would reject; the form submit below
          // commits url + mode atomically in one mutate.
          setDraftManual(true)
          return
        }
        setDraftManual(false)
        controller.save({ mode })
      }
      const manualActive = state.mode === 'manual' || draftManual
      const status = state.error || (state.status === 'saving' ? t('saving') : state.status === 'ready' ? t('ready') : '')
      return React.createElement('div', { className: 'dshNetworkProxyRow' },
        React.createElement('div', { className: 'dshNetworkProxyHeader' },
          React.createElement('div', { className: 'dshNetworkProxyCopy' },
            React.createElement('div', { className: 'dshNetworkProxyTitle' }, t('title')),
            React.createElement('div', { className: 'dshNetworkProxyDesc' }, t('description')),
            status && React.createElement('div', { className: 'dshNetworkProxyStatus', 'data-error': Boolean(state.error), role: state.error ? 'alert' : undefined }, status),
          ),
          React.createElement('div', { className: 'dshNetworkProxyModes', role: 'radiogroup', 'aria-label': t('title') },
            ['system', 'manual', 'direct'].map((mode) => React.createElement('button', {
              key: mode,
              type: 'button',
              role: 'radio',
              'aria-checked': state.mode === mode || (mode === 'manual' && draftManual),
              'data-active': state.mode === mode || (mode === 'manual' && draftManual),
              className: 'dshNetworkProxyMode',
              disabled,
              onClick: () => choose(mode),
            }, t(mode))),
          ),
        ),
        manualActive && React.createElement('form', {
          className: 'dshNetworkProxyManual',
          onSubmit: (event) => { event.preventDefault(); controller.save({ url: url.trim(), mode: 'manual' }) },
        },
          React.createElement('input', {
            className: 'dshNetworkProxyInput',
            type: 'text',
            inputMode: 'url',
            value: url,
            placeholder: t('placeholder'),
            disabled,
            required: true,
            autoFocus: draftManual,
            'aria-label': t('manual'),
            onChange: (event) => setUrl(event.target.value),
          }),
          React.createElement('button', { className: 'dshNetworkProxyApply', type: 'submit', disabled: disabled || !url.trim() || (state.mode === 'manual' && url.trim() === state.url) }, t('apply')),
        ),
      )
    }

    const inject = ['slots', 'locale', 'connection', 'remote']
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'network-proxy: dictionaries')
      const t = ctx.locale.bind(NS)
      const controller = new NetworkProxyController(ctx.get('connection').api)
      const useProxy = (selector) => React.useSyncExternalStore(
        (listener) => controller.store.subscribe(listener),
        () => selector(controller.store.getSnapshot()),
        () => selector(controller.store.getSnapshot()),
      )
      const injected = () => ({ controller, useProxy })
      ctx.effect(() => {
        const refresh = () => {
          if (controller.store.getSnapshot().status !== 'idle') controller.load()
        }
        const disposers = [
          ctx.remote.$on('settings/document-updated', (ns) => { if (ns === SETTINGS_NS) refresh() }),
          ctx.on('connection/reset', refresh),
        ]
        return () => { controller.dispose(); for (const dispose of disposers) dispose() }
      }, 'network-proxy: invalidations')
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'network-proxy',
        order: -10,
        locale: NS,
        inject: injected,
      }, NetworkProxyRow))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
