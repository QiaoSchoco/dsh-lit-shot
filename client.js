/**
 * Browser half of dsh-lit-shot.
 *
 * Adds one scissors button to the composer tool row, right after the shipped
 * command button. A left click asks the Host half to start a capture; the Host's
 * resident Windows agent owns the global hotkey and the full-screen overlay, crops
 * the selection, and answers with a PNG data URL. A capture taken through the global
 * hotkey arrives through the pending route instead, so the same picture lands in the
 * composer even when the click never happened. Either way the picture is handed to
 * the shipped draft-attachment API, so it is sent as an ordinary image.
 */
window.__ModuleLoader__.load({
  id: "dsh-lit-shot",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    let ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch {
      ReactDOM = null;
    }

    const NS = "dsh-lit-shot";
    const HEADERS = { "x-dsh-lit-shot": "1", "content-type": "application/json" };
    const POLL_MS = 700;

    const DICT = {
      zh: {
        "button.label": "截图",
        "button.title": "截图（{hotkey}）· 右键设置快捷键",
        "status.busy": "正在截屏…请框选区域",
        "status.inserted": "已插入截图",
        "status.cancelled": "已取消截图",
        "status.failed": "截图失败：",
        "status.copied": "无法插入输入框，图片已复制到剪贴板",
        "status.nocomposer": "输入框还没准备好",
        "menu.title": "截图快捷键",
        "menu.change": "修改快捷键",
        "menu.press": "请按下新的组合键…",
        "menu.pressHint": "至少要有一个 Ctrl / Alt / Shift / Win；Esc 返回",
        "menu.saving": "正在保存…",
        "menu.saved": "已保存",
        "menu.failed": "保存失败：",
        "menu.off": "未注册",
        "menu.hint": "点按钮即可框选截图；框选时按 Esc 或右键取消",
      },
      en: {
        "button.label": "Screenshot",
        "button.title": "Screenshot ({hotkey}) · right-click for the shortcut",
        "status.busy": "Capturing… drag a region",
        "status.inserted": "Screenshot inserted",
        "status.cancelled": "Capture cancelled",
        "status.failed": "Capture failed: ",
        "status.copied": "Could not reach the composer; the picture is on the clipboard",
        "status.nocomposer": "The composer is not ready yet",
        "menu.title": "Screenshot shortcut",
        "menu.change": "Change shortcut",
        "menu.press": "Press the new combination…",
        "menu.pressHint": "Needs at least one of Ctrl / Alt / Shift / Win; Esc goes back",
        "menu.saving": "Saving…",
        "menu.saved": "Saved",
        "menu.failed": "Could not save: ",
        "menu.off": "Not registered",
        "menu.hint": "Click the button to pick a region; Esc or right-click cancels",
      },
    };

    const T = {
      text: "var(--dsw-alias-label-primary)",
      subtle: "var(--dsw-alias-label-secondary)",
      surface: "var(--dsw-alias-bg-overlay)",
      hover: "var(--dsw-alias-bg-layer-2)",
      border: "var(--dsw-alias-border-l1)",
      error: "var(--dsw-alias-state-error-primary)",
      success: "var(--dsw-alias-state-success-primary)",
    };

    let pluginCtx = null;
    let tr = (key, params) => interpolate(DICT.zh[key] ?? DICT.en[key] ?? key, params);

    /** Replace `{name}` placeholders. */
    function interpolate(text, params) {
      if (params === undefined || params === null) return text;
      return String(text).replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
    }

    /** Map a locale tag onto `zh` or `en`. */
    function bundledLanguage(tag) {
      if (typeof tag !== "string" || tag === "") return undefined;
      const base = tag.toLowerCase().replace(/_/g, "-").split("-")[0];
      return Object.prototype.hasOwnProperty.call(DICT, base) ? base : undefined;
    }

    /** The translator of this plugin namespace, with a bundled fallback. */
    function makeTranslator(ctx) {
      const ids = Object.keys(DICT);
      const registered = new Set();
      let bound = null;
      let language = "en";
      try {
        const tags = Array.isArray(navigator.languages) && navigator.languages.length > 0 ? navigator.languages : [navigator.language];
        for (const tag of tags) {
          const id = bundledLanguage(tag);
          if (id !== undefined) {
            language = id;
            break;
          }
        }
      } catch {
        language = "en";
      }

      /** Publish the dictionaries and bind the namespace once. */
      function connect(locale) {
        if (locale === undefined || locale === null) return;
        if (registered.size < ids.length && typeof locale.register === "function") {
          for (const id of ids) {
            if (registered.has(id)) continue;
            registered.add(id);
            try {
              locale.register(NS, id, DICT[id]);
            } catch {
              /* another mount of this module already owns it */
            }
          }
        }
        if (bound === null && typeof locale.bind === "function") {
          try {
            bound = locale.bind(NS);
          } catch {
            bound = null;
          }
        }
      }

      return (key, params) => {
        try {
          let locale = ctx === undefined || ctx === null ? undefined : ctx.locale;
          if (locale === undefined && typeof ctx?.get === "function") locale = ctx.get("locale");
          if (locale !== undefined && locale !== null) {
            connect(locale);
            const snapshot = typeof locale.getLocale === "function" ? locale.getLocale() : undefined;
            const active = snapshot === undefined || snapshot === null ? undefined : snapshot.active ?? snapshot.id;
            const id = bundledLanguage(active);
            if (id !== undefined) language = id;
          }
        } catch {
          /* keep the bundled dictionary */
        }
        if (bound !== null) {
          try {
            const value = bound(key, params);
            if (typeof value === "string" && value !== "" && value !== key) return value;
          } catch {
            /* fall through */
          }
        }
        return interpolate(DICT[language][key] ?? DICT.en[key] ?? key, params);
      };
    }

    /** Absolute URL for one of this plugin's routes. */
    function routeUrl(path) {
      const boot = typeof window === "undefined" ? undefined : window.__DSH_BOOT__;
      const origin = typeof location !== "undefined" && typeof location.origin === "string" && location.origin.startsWith("http")
        ? location.origin
        : typeof boot === "object" && boot !== null && typeof boot.origin === "string" && boot.origin.startsWith("http")
          ? boot.origin
          : undefined;
      return origin === undefined ? path : `${origin.replace(/\/+$/, "")}${path}`;
    }

    /** The conversation service, when the profile provides it. */
    function conversationService() {
      if (pluginCtx === null || typeof pluginCtx.get !== "function") return undefined;
      try {
        const service = pluginCtx.get("conversation");
        return service === undefined || service === null ? undefined : service;
      } catch {
        return undefined;
      }
    }

    /**
     * Hand one picture to the composer as a normal image draft.
     * @returns null on success, otherwise a short reason.
     */
    function insertDraft(file, sessionId, inputActions) {
      const conversation = conversationService();
      if (conversation === undefined || typeof conversation.createDrafts !== "function") return "conversation";
      if (inputActions === undefined || inputActions === null || typeof inputActions.addAttachments !== "function") return "inputActions";
      let drafts;
      try {
        drafts = conversation.createDrafts(sessionId, [file]);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      if (!Array.isArray(drafts) || drafts.length === 0) return "draft";
      if (inputActions.addAttachments(drafts.map((draft) => draft.id)) !== true) {
        try {
          conversation.releaseDraftAttachments(drafts);
        } catch {
          /* nothing else to undo */
        }
        return "rejected";
      }
      return null;
    }

    /** Decode a data URL into a File the composer accepts. */
    function dataUrlToFile(dataUrl, fileName, mediaType) {
      const comma = dataUrl.indexOf(",");
      const binary = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new File([bytes], fileName || "screenshot.png", { type: mediaType || "image/png" });
    }

    /** Best-effort clipboard fallback when the composer refuses the draft. */
    async function copyToClipboard(dataUrl) {
      try {
        if (typeof ClipboardItem === "undefined" || typeof navigator === "undefined" || navigator.clipboard === undefined) return false;
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
        return true;
      } catch {
        return false;
      }
    }

    const S = {
      anchor: { position: "relative", display: "inline-flex", alignItems: "center" },
      button: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        border: "none",
        borderRadius: 8,
        background: "transparent",
        color: T.subtle,
        cursor: "pointer",
      },
      popover: {
        position: "fixed",
        zIndex: 90,
        width: 288,
        padding: 10,
        borderRadius: 10,
        border: `1px solid ${T.border}`,
        background: T.surface,
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
        color: T.text,
        fontSize: 12,
        lineHeight: "18px",
        textAlign: "left",
      },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
      key: {
        padding: "2px 8px",
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: T.hover,
        font: "inherit",
        fontVariantNumeric: "tabular-nums",
      },
      action: {
        marginTop: 8,
        width: "100%",
        padding: "6px 10px",
        borderRadius: 7,
        border: `1px solid ${T.border}`,
        background: "transparent",
        color: T.text,
        cursor: "pointer",
        font: "inherit",
      },
      hint: { marginTop: 8, color: T.subtle, fontSize: 11, lineHeight: "16px" },
      pressed: {
        marginTop: 8,
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px dashed ${T.border}`,
        color: T.subtle,
        textAlign: "center",
      },
      toast: {
        position: "fixed",
        zIndex: 90,
        maxWidth: 420,
        padding: "8px 12px",
        borderRadius: 9,
        border: `1px solid ${T.border}`,
        background: T.surface,
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
        fontSize: 12,
        wordBreak: "break-all",
      },
    };

    const ScissorsIcon = () =>
      h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, focusable: false },
        h("circle", { cx: 4.1, cy: 11.9, r: 2.1, stroke: "currentColor", strokeWidth: 1.2 }),
        h("circle", { cx: 11.9, cy: 11.9, r: 2.1, stroke: "currentColor", strokeWidth: 1.2 }),
        h("path", { d: "M5.4 10.4 12.9 2.3", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }),
        h("path", { d: "M10.6 10.4 3.1 2.3", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }),
      );

    /** Compose a hotkey spec from one keyboard event, or null while it is incomplete. */
    function specFromEvent(event) {
      const mods = [];
      if (event.ctrlKey) mods.push("Ctrl");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey) mods.push("Shift");
      if (event.metaKey) mods.push("Win");
      const code = typeof event.code === "string" ? event.code : "";
      let key = "";
      if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
      else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
      else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
      if (key === "" || mods.length === 0) return null;
      return [...mods, key].join("+");
    }

    /**
     * The composer scissors button.
     * @param props - slot props carrying the composer's actions and session id.
     */
    function ShotButton(props) {
      const inputActions = props === undefined ? undefined : props.inputActions;
      const sessionId = props === undefined ? undefined : props.sessionId;
      const [busy, setBusy] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const [menu, setMenu] = React.useState(null);
      const hostRef = React.useRef(null);
      const busyRef = React.useRef(false);
      const sessionRef = React.useRef(sessionId);
      sessionRef.current = sessionId;

      busyRef.current = busy;

      React.useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 6000);
        return () => clearTimeout(timer);
      }, [toast]);

      /** Show one status line under the button. */
      const flash = (kind, text) => setToast({ kind, text });

      /** Insert one captured picture into the composer. */
      const insert = React.useCallback(async (shot) => {
        if (shot === null || typeof shot.dataUrl !== "string") {
          flash("error", tr("status.failed") + "empty response");
          return;
        }
        const file = dataUrlToFile(shot.dataUrl, shot.name, shot.mediaType);
        const failure = insertDraft(file, sessionRef.current, inputActions);
        if (failure === null) {
          flash("ok", tr("status.inserted"));
          return;
        }
        if (failure === "conversation" || failure === "inputActions") {
          const copied = await copyToClipboard(shot.dataUrl);
          flash("error", copied ? tr("status.copied") : tr("status.nocomposer"));
          return;
        }
        flash("error", tr("status.failed") + failure);
      }, [inputActions]);

      /** Ask the Host for one capture and wait for the region drag. */
      const capture = async () => {
        if (busyRef.current) return;
        setMenu(null);
        setBusy(true);
        flash("busy", tr("status.busy"));
        try {
          const response = await fetch(routeUrl("/dsh-lit-shot/capture"), {
            method: "POST",
            headers: HEADERS,
            body: "{}",
          });
          const result = await response.json();
          if (result.ok !== true) {
            flash("idle", result.cancelled === true ? tr("status.cancelled") : `${tr("status.failed")}${result.error ?? ""}`);
            return;
          }
          await insert(result);
        } catch (error) {
          flash("error", `${tr("status.failed")}${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      /** Poll for captures taken through the global hotkey. */
      React.useEffect(() => {
        if (sessionId === undefined) return undefined;
        let stopped = false;
        let timer = null;
        const tick = async () => {
          if (stopped) return;
          timer = setTimeout(tick, POLL_MS);
          if (busyRef.current) return;
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          try {
            const response = await fetch(routeUrl("/dsh-lit-shot/pending"), { headers: HEADERS, cache: "no-store" });
            const data = await response.json();
            if (data.ok !== true || data.shot === null || data.shot === undefined) return;
            const shotResponse = await fetch(routeUrl(`/dsh-lit-shot/shot?id=${encodeURIComponent(data.shot.id)}`), { headers: HEADERS, cache: "no-store" });
            const shot = await shotResponse.json();
            if (shot.ok !== true) return;
            setBusy(true);
            try {
              await insert(shot);
            } catch {
              /* claimed below so a bad payload cannot loop the poller */
            } finally {
              setBusy(false);
            }
            try {
              await fetch(routeUrl("/dsh-lit-shot/claim"), { method: "POST", headers: HEADERS, body: JSON.stringify({ id: data.shot.id }) });
            } catch {
              /* the host will drop it on the next agent restart anyway */
            }
          } catch {
            /* the host restarted or the page is closing */
          }
        };
        timer = setTimeout(tick, 1_200);
        return () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [sessionId, insert]);

      /** Keep the button right after the shipped command button. */
      React.useEffect(() => {
        const host = hostRef.current;
        if (host === null) return undefined;
        let observer = null;
        let watched = null;

        /** The shipped `+` button and the container whose child sits beside it. */
        const locate = () => {
          let node = host;
          while (node !== null && node !== document.body) {
            const parent = node.parentElement;
            if (parent === null) return null;
            const plus = Array.from(parent.children).find((child) => child.tagName === "BUTTON" && child.getAttribute("aria-haspopup") === "listbox");
            if (plus !== undefined) return { plus, parent, node };
            node = parent;
          }
          return null;
        };

        const place = () => {
          const found = locate();
          if (found === null) return;
          if (found.plus.nextElementSibling !== found.node) found.parent.insertBefore(found.node, found.plus.nextElementSibling);
          if (watched !== found.parent) {
            if (observer !== null) observer.disconnect();
            watched = found.parent;
            try {
              observer = new MutationObserver(() => place());
              observer.observe(watched, { childList: true });
            } catch {
              observer = null;
            }
          }
        };

        place();
        return () => {
          if (observer !== null) observer.disconnect();
        };
      }, []);

      /** Load the current hotkey when the popover opens. */
      const openMenu = async () => {
        setMenu({ stage: "idle", hotkey: "…", hotkeyOk: true, error: "", note: "" });
        try {
          const response = await fetch(routeUrl("/dsh-lit-shot/settings"), { headers: HEADERS, cache: "no-store" });
          const data = await response.json();
          setMenu({
            stage: "idle",
            hotkey: typeof data.hotkey === "string" ? data.hotkey : "…",
            hotkeyOk: data.hotkeyOk === true,
            error: typeof data.error === "string" ? data.error : "",
            note: "",
          });
        } catch (error) {
          setMenu({ stage: "idle", hotkey: "…", hotkeyOk: false, error: error instanceof Error ? error.message : String(error), note: "" });
        }
      };

      /** Save a new hotkey through the Host. */
      const saveHotkey = async (spec) => {
        setMenu((current) => (current === null ? current : { ...current, stage: "idle", note: tr("menu.saving") }));
        try {
          const response = await fetch(routeUrl("/dsh-lit-shot/settings"), {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({ hotkey: spec }),
          });
          const data = await response.json();
          if (data.ok === true) {
            setMenu((current) => (current === null ? current : { ...current, hotkey: data.hotkey, hotkeyOk: true, error: "", note: tr("menu.saved") }));
            return;
          }
          setMenu((current) => (current === null ? current : { ...current, hotkeyOk: false, error: String(data.error ?? ""), note: tr("menu.failed") }));
        } catch (error) {
          setMenu((current) => (current === null ? current : { ...current, hotkeyOk: false, error: error instanceof Error ? error.message : String(error), note: tr("menu.failed") }));
        }
      };

      /** Turn the next key combination into the new hotkey. */
      React.useEffect(() => {
        if (menu === null || menu.stage !== "editing") return undefined;
        const onKeyDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            setMenu((current) => (current === null ? current : { ...current, stage: "idle", note: "" }));
            return;
          }
          const spec = specFromEvent(event);
          if (spec !== null) void saveHotkey(spec);
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
      }, [menu]);

      React.useEffect(() => {
        if (menu === null) return undefined;
        const close = (event) => {
          const target = event.target;
          if (hostRef.current !== null && hostRef.current.contains(target)) return;
          if (target instanceof Element && target.closest("[data-dsh-lit-shot-popover]") !== null) return;
          setMenu(null);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setMenu(null);
        };
        document.addEventListener("pointerdown", close, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("pointerdown", close, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [menu]);

      const anchor = () => {
        const rect = hostRef.current === null ? null : hostRef.current.getBoundingClientRect();
        return rect === null
          ? { left: 12, bottom: 90 }
          : { left: Math.max(8, Math.min(rect.left, Math.max(8, window.innerWidth - 300))), bottom: Math.max(8, window.innerHeight - rect.top + 8) };
      };

      const popover = () => {
        if (menu === null) return null;
        const pinned = { ...S.popover, ...anchor() };
        const keyText = menu.hotkeyOk ? menu.hotkey : (menu.hotkey === "…" ? "…" : `${menu.hotkey} · ${tr("menu.off")}`);
        const body = [];
        body.push(h("div", { key: "row", style: S.row },
          h("span", { style: { color: T.subtle } }, tr("menu.title")),
          h("span", { style: { ...S.key, color: menu.hotkeyOk ? T.text : T.error } }, keyText),
        ));
        if (menu.error !== "" && menu.hotkeyOk !== true) {
          body.push(h("div", { key: "err", style: { ...S.hint, color: T.error } }, menu.error));
        }
        if (menu.stage === "editing") {
          body.push(h("div", { key: "press", style: S.pressed }, tr("menu.press")));
          body.push(h("div", { key: "pressHint", style: S.hint }, tr("menu.pressHint")));
        } else {
          body.push(h("button", {
            key: "change",
            type: "button",
            style: S.action,
            onClick: () => setMenu((current) => (current === null ? current : { ...current, stage: "editing", note: "" })),
          }, tr("menu.change")));
          body.push(h("div", { key: "hint", style: S.hint }, tr("menu.hint")));
          if (menu.note !== "") body.push(h("div", { key: "note", style: { ...S.hint, color: T.success } }, menu.note));
        }
        return h("div", { style: pinned, "data-dsh-lit-shot-popover": "true" }, body);
      };

      const toastView = () => {
        if (toast === null) return null;
        const color = toast.kind === "error" ? T.error : toast.kind === "ok" ? T.success : T.subtle;
        return h("div", {
          style: { ...S.toast, ...anchor(), color, borderColor: toast.kind === "error" ? T.error : T.border },
        }, toast.text);
      };

      const overlay = () => {
        if (ReactDOM === null || typeof document === "undefined") return null;
        const nodes = [];
        const pop = popover();
        if (pop !== null) nodes.push(ReactDOM.createPortal(pop, document.body));
        const line = toastView();
        if (line !== null) nodes.push(ReactDOM.createPortal(line, document.body));
        if (nodes.length === 0) return null;
        return h(React.Fragment, null, nodes);
      };

      return h("span", { style: S.anchor, ref: hostRef },
        h("button", {
          type: "button",
          style: { ...S.button, opacity: busy ? 0.5 : 1 },
          title: tr("button.title", { hotkey: menu !== null && menu.hotkeyOk ? menu.hotkey : "Alt+A" }),
          "aria-label": tr("button.label"),
          "aria-haspopup": "dialog",
          "aria-expanded": menu !== null,
          tabIndex: -1,
          disabled: busy || sessionId === undefined,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => { void capture(); },
          onContextMenu: (event) => {
            event.preventDefault();
            if (menu === null) void openMenu();
            else setMenu(null);
          },
        }, h(ScissorsIcon, null)),
        overlay(),
      );
    }

    /** Register the composer button. */
    function apply(ctx) {
      pluginCtx = ctx;
      tr = makeTranslator(ctx);
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-lit-shot",
        order: 40,
        label: tr("button.label"),
      }, ShotButton));
    }

    return {
      name: NS,
      inject: ["slots"],
      apply,
    };
  },
});
