// dsh-prompt-suggest — browser half.
//
// One slot contribution: conversation.input.overlay, the floating layer
// inside the resident composer card. It paints a single grey inline
// prediction on the editor's first line (Claude-Code style):
//
//   Tab          accept the prediction into the draft (never sends)
//   ArrowUp      recall the previous sent prompt for this Session
//   ArrowDown    walk forward through recalled prompts
//   Escape       hide the prediction for this turn
//
// The prediction only exists while the draft is empty and the composer is
// idle, so it can never overwrite something the user is typing.
//
// Hand-written CJS: the loader only needs { id, factory } and a module face
// carrying apply/inject, so this package has no build step.
window.__ModuleLoader__.load({
  id: "dsh-prompt-suggest",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const ROUTE = "/api/prompt-suggest";
    const STYLE_ID = "dsh-prompt-suggest-style";
    const ENABLED_KEY = "dsh.prompt-suggest.enabled";
    const CHANGE_EVENT = "dsh-prompt-suggest:change";
    const HISTORY_LIMIT = 60;
    const GHOST_ELEMENT_ID = "dsh-prompt-suggest-ghost";

    const CSS = [
      ".dsh-ps-ghost{position:fixed;display:none;z-index:2147483000;align-items:baseline;gap:8px;pointer-events:none;",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;",
      "color:var(--dsw-alias-text-tertiary,rgba(148,148,148,.9))}",
      ".dsh-ps-ghost-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;opacity:.9}",
      ".dsh-ps-key{flex:none;font-size:10px;line-height:1;padding:2px 4px;border-radius:4px;",
      "border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.32));opacity:.6;",
      "font-family:inherit;transform:translateY(-1px)}",
      ".dsh-ps-setting{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 4px}",
      ".dsh-ps-setting-title{font-size:13px;line-height:1.5}",
      ".dsh-ps-setting-desc{font-size:12px;line-height:1.6;opacity:.6;margin-top:2px}",
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function post(body) {
      return fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => response.json());
    }

    function readEnabled() {
      try {
        return window.localStorage.getItem(ENABLED_KEY) !== "0";
      } catch {
        return true;
      }
    }

    function writeEnabled(value) {
      try {
        window.localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
      } catch {
        // Storage is a convenience; the in-memory state still applies.
      }
      try {
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { enabled: value } }));
      } catch {
        // CustomEvent is available in every supported renderer.
      }
    }

    function useEnabled() {
      const [enabled, setEnabled] = React.useState(readEnabled);
      React.useEffect(() => {
        const sync = () => setEnabled(readEnabled());
        window.addEventListener(CHANGE_EVENT, sync);
        window.addEventListener("storage", sync);
        return () => {
          window.removeEventListener(CHANGE_EVENT, sync);
          window.removeEventListener("storage", sync);
        };
      }, []);
      return [enabled, writeEnabled];
    }

    function pickSessionId(props) {
      const session = props && props.session;
      const candidates = [
        session && session.sessionId,
        session && session.id,
        props && props.sessionId,
        session && session.session && session.session.sessionId,
      ];
      for (const value of candidates) {
        if (typeof value === "string" && value !== "") return value;
      }
      return undefined;
    }

    function useNothing() {
      return undefined;
    }

    /** The resident composer card and the Lexical editor surface inside it. */
    function findComposer() {
      if (typeof document === "undefined") return { card: null, editor: null };
      const cards = Array.from(document.querySelectorAll("[data-composer-card]"));
      let card = null;
      const active = document.activeElement;
      if (active) {
        for (const candidate of cards) {
          if (candidate.contains(active)) {
            card = candidate;
            break;
          }
        }
      }
      if (!card) card = cards[0] || null;
      if (!card) return { card: null, editor: null };
      let editor = card.querySelector("[contenteditable='true']");
      if (!editor) editor = card.querySelector("[data-lexical-editor='true']");
      return { card, editor };
    }

    /** The opaque surface behind the editor, used to mask the native placeholder. */
    function readComposerSurface(card) {
      let node = card;
      while (node && node.nodeType === 1) {
        const background = window.getComputedStyle(node).backgroundColor;
        if (background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
          return background;
        }
        node = node.parentElement;
      }
      return "var(--dsw-alias-surface-raised, transparent)";
    }

    function isInsideComposer(target) {
      const { card } = findComposer();
      return Boolean(card) && Boolean(target) && typeof card.contains === "function"
        && card.contains(target);
    }

    function focusEditorAtEnd() {
      const { editor } = findComposer();
      if (!editor) return;
      try {
        editor.focus();
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch {
        // Focus is a nicety; the draft edit already succeeded.
      }
    }

    /**
     * The ghost lives on the document body as a fixed layer. The composer card
     * clips and restacks its own children, so an in-card absolute layer can be
     * painted underneath the editor; a body-level fixed layer cannot.
     */
    function ensureGhostElement() {
      if (typeof document === "undefined") return null;
      const existing = document.getElementById(GHOST_ELEMENT_ID);
      if (existing) return existing;
      const element = document.createElement("div");
      element.id = GHOST_ELEMENT_ID;
      element.className = "dsh-ps-ghost";
      element.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "dsh-ps-ghost-text";
      const key = document.createElement("span");
      key.className = "dsh-ps-key";
      key.textContent = "Tab";
      element.appendChild(text);
      element.appendChild(key);
      document.body.appendChild(element);
      return element;
    }

    function updateGhostText(element, value) {
      if (!element) return;
      const text = element.querySelector(".dsh-ps-ghost-text");
      if (text) text.textContent = value || "";
      element.style.display = value ? "flex" : "none";
    }

    function placeGhostFixed(element) {
      const { card, editor } = findComposer();
      if (!element || !card || !editor) return false;
      const rect = editor.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(editor);
      const number = (value) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const padLeft = number(style.paddingLeft);
      const padTop = number(style.paddingTop);
      const borderLeft = number(style.borderLeftWidth);
      const borderTop = number(style.borderTopWidth);
      const lineHeight = number(style.lineHeight) || number(style.fontSize) * 1.5 || 20;
      element.style.left = Math.round(rect.left + borderLeft + padLeft) + "px";
      element.style.top = Math.round(rect.top + borderTop + padTop) + "px";
      element.style.width = Math.max(80, Math.round(rect.width - padLeft * 2)) + "px";
      element.style.height = Math.round(lineHeight) + "px";
      element.style.lineHeight = Math.round(lineHeight) + "px";
      element.style.fontFamily = style.fontFamily;
      element.style.fontSize = style.fontSize;
      element.style.background = readComposerSurface(card);
      return true;
    }

    function Ghost(props) {
      const useInput = typeof props.useInput === "function" ? props.useInput : useNothing;
      const hookDraft = useInput((state) => (state ? state.draft : undefined));
      const hookPhase = useInput((state) => (state ? state.phase : undefined));
      const ownerInput = props.input;
      const draft = hookDraft !== undefined ? hookDraft : (ownerInput ? ownerInput.draft : undefined);
      const phase = hookPhase !== undefined ? hookPhase : (ownerInput ? ownerInput.phase : undefined);
      const sessionId = pickSessionId(props);
      const [enabled] = useEnabled();

      const ghostElRef = React.useRef(null);
      const [text, setText] = React.useState("");
      const [visible, setVisible] = React.useState(false);
      const [cooldownUntil, setCooldownUntil] = React.useState(0);

      const textRef = React.useRef("");
      const draftRef = React.useRef(draft);
      const historyRef = React.useRef([]);
      const historyAtRef = React.useRef(-1);
      const historyLoadingRef = React.useRef(false);
      const historyFillRef = React.useRef("");
      const actionsRef = React.useRef(props.inputActions);
      const sessionRef = React.useRef(sessionId);
      const reportedRef = React.useRef(false);
      const suppressedRef = React.useRef(false);

      actionsRef.current = props.inputActions;
      sessionRef.current = sessionId;
      draftRef.current = draft;

      const show = (value) => {
        if (!value) return;
        textRef.current = value;
        setText(value);
        setVisible(true);
      };

      const hide = () => {
        textRef.current = "";
        setText("");
        setVisible(false);
      };

      const accept = () => {
        const value = textRef.current;
        if (!value) return;
        try {
          const actions = actionsRef.current;
          if (actions && typeof actions.setDraft === "function") actions.setDraft(value);
        } catch {
          // Leave the draft untouched when the public action is unavailable.
        }
        hide();
        setTimeout(focusEditorAtEnd, 30);
      };

      const fillHistory = (value) => {
        historyFillRef.current = value;
        try {
          const actions = actionsRef.current;
          if (actions && typeof actions.setDraft === "function") actions.setDraft(value);
        } catch {
          // Keep the local index in sync even when the draft cannot be set.
        }
        setTimeout(focusEditorAtEnd, 30);
      };

      const ensureHistory = async () => {
        if (historyRef.current.length > 0) return true;
        if (historyLoadingRef.current) return false;
        const current = sessionRef.current;
        if (current === undefined) return false;
        historyLoadingRef.current = true;
        try {
          const result = await post({ method: "history", sessionId: current });
          const list = result && Array.isArray(result.history)
            ? result.history.filter((item) => typeof item === "string" && item !== "")
            : [];
          historyRef.current = list.slice(0, HISTORY_LIMIT);
          return historyRef.current.length > 0;
        } catch {
          return false;
        } finally {
          historyLoadingRef.current = false;
        }
      };

      const recall = async (direction) => {
        if (direction < 0) {
          if (historyAtRef.current < 0) {
            const ready = await ensureHistory();
            if (!ready) return;
            historyAtRef.current = 0;
            fillHistory(historyRef.current[0]);
            return;
          }
          if (historyAtRef.current >= historyRef.current.length - 1) return;
          historyAtRef.current += 1;
          fillHistory(historyRef.current[historyAtRef.current]);
          return;
        }
        if (historyAtRef.current < 0) return;
        historyAtRef.current -= 1;
        fillHistory(historyAtRef.current < 0 ? "" : historyRef.current[historyAtRef.current]);
      };

      // Keep the draft mailbox in sync with history navigation: any manual
      // edit detaches from the recalled entry so ArrowUp starts over. A draft
      // that just went empty means the user sent (or cleared) it; the Host's
      // session snapshot can lag behind that write, so stay quiet briefly
      // instead of resurrecting the previous turn's prediction.
      const previousDraftRef = React.useRef(draft);
      React.useEffect(() => {
        const previous = previousDraftRef.current;
        previousDraftRef.current = draft;
        if (draft !== historyFillRef.current) historyAtRef.current = -1;
        if (draft === "") historyFillRef.current = "";
        if (previous !== "" && previous !== undefined && (draft === "" || draft === undefined)) {
          setCooldownUntil(Date.now() + 6000);
          const timer = setTimeout(() => setCooldownUntil(0), 6000);
          return () => clearTimeout(timer);
        }
        return undefined;
      }, [draft]);

      // One polling loop: ask for a prediction only while the composer is
      // idle and empty; stop as soon as one is on screen.
      const eligible = enabled
        && sessionId !== undefined
        && Date.now() >= cooldownUntil
        && (draft === undefined || draft === "")
        && (phase === undefined || phase === "plain");

      React.useEffect(() => {
        if (!eligible) {
          suppressedRef.current = false;
          hide();
          return undefined;
        }
        // A fresh idle turn discards both the prediction and the recall cache.
        historyRef.current = [];
        historyAtRef.current = -1;
        if (suppressedRef.current) return undefined;
        if (textRef.current) return undefined;
        let alive = true;
        let timer;
        let delay = 800;
        const tickpoll = () => {
          post({ method: "get", sessionId })
            .then((result) => {
              if (!alive) return;
              if (result && result.ok === true) {
                const next = typeof result.suggestion === "string" && result.suggestion !== ""
                  ? result.suggestion
                  : (Array.isArray(result.candidates) && typeof result.candidates[0] === "string"
                    ? result.candidates[0]
                    : "");
                if (next) {
                  show(next);
                  return;
                }
                if (result.code === "TURN_IN_FLIGHT") {
                  // A turn is running; check back soon so the prediction lands
                  // right after it ends instead of waiting for a long backoff.
                  delay = 3000;
                } else if (result.pending === true) {
                  delay = Math.min(Math.round(delay * 1.5), 5000);
                } else {
                  delay = Math.min(delay * 2, 20000);
                }
              } else {
                delay = Math.min(delay * 2, 20000);
              }
              timer = setTimeout(tickpoll, delay);
            })
            .catch(() => {
              if (!alive) return;
              delay = Math.min(delay * 2, 20000);
              timer = setTimeout(tickpoll, delay);
            });
        };
        tickpoll();
        return () => {
          alive = false;
          if (timer !== undefined) clearTimeout(timer);
        };
      }, [eligible, sessionId]);

      // Paint and re-measure the fixed ghost layer after mount and whenever
      // the draft, the viewport or the composer layout changes.
      React.useEffect(() => {
        const element = ensureGhostElement();
        if (!element) return undefined;
        ghostElRef.current = element;
        updateGhostText(element, visible ? text : "");
        if (!visible) return undefined;
        let alive = true;
        const measure = () => {
          if (!alive) return;
          const placed = placeGhostFixed(element);
          element.style.display = placed ? "flex" : "none";
          if (placed && !reportedRef.current) {
            reportedRef.current = true;
            const { card, editor } = findComposer();
            const editorRect = editor ? editor.getBoundingClientRect() : null;
            const ghostRect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              ghostRect.left + 8,
              ghostRect.top + Math.min(8, ghostRect.height / 2),
            );
            post({
              method: "diag",
              payload: {
                version: "v4-fixed",
                found: { card: Boolean(card), editor: Boolean(editor) },
                editorRect: editorRect
                  ? {
                    x: Math.round(editorRect.left),
                    y: Math.round(editorRect.top),
                    w: Math.round(editorRect.width),
                    h: Math.round(editorRect.height),
                  }
                  : null,
                ghostRect: {
                  x: Math.round(ghostRect.left),
                  y: Math.round(ghostRect.top),
                  w: Math.round(ghostRect.width),
                  h: Math.round(ghostRect.height),
                },
                display: window.getComputedStyle(element).display,
                hit: hit
                  ? (hit.id === GHOST_ELEMENT_ID ? "self" : String(hit.className || hit.tagName).slice(0, 60))
                  : "none",
                text: textRef.current.slice(0, 40),
              },
            }).catch(() => {});
          }
        };
        measure();
        const frame = requestAnimationFrame(measure);
        const interval = setInterval(measure, 800);
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
          alive = false;
          cancelAnimationFrame(frame);
          clearInterval(interval);
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [visible, text]);

      // The body-level node outlives React renders; drop it with the plugin.
      React.useEffect(() => () => {
        const element = document.getElementById(GHOST_ELEMENT_ID);
        if (element && element.parentElement) element.parentElement.removeChild(element);
      }, []);

      // Keyboard layer. Capture phase so the composer's own handlers run
      // only when we deliberately let an event through.
      const handlerRef = React.useRef(null);
      handlerRef.current = (event) => {
        if (!enabled) return;
        if (event.isComposing || event.keyCode === 229) return;
        if (!isInsideComposer(event.target)) return;
        const key = event.key;
        if (key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (!textRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          accept();
          return;
        }
        if (key === "ArrowUp" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          if (draftRef.current !== "" && draftRef.current !== undefined) return;
          event.preventDefault();
          event.stopPropagation();
          recall(-1);
          return;
        }
        if (key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          if (historyAtRef.current < 0) return;
          event.preventDefault();
          event.stopPropagation();
          recall(1);
          return;
        }
        if (key === "Escape" && textRef.current) {
          suppressedRef.current = true;
          hide();
        }
      };

      React.useEffect(() => {
        const listener = (event) => {
          if (handlerRef.current) handlerRef.current(event);
        };
        document.addEventListener("keydown", listener, true);
        return () => document.removeEventListener("keydown", listener, true);
      }, []);

      // A fresh turn invalidates the prediction and the recalled position.
      React.useEffect(() => {
        historyAtRef.current = -1;
        historyFillRef.current = "";
        historyRef.current = [];
      }, [sessionId]);

      return null;
    }

    function SettingsSection() {
      const [enabled, setEnabled] = useEnabled();
      return h(
        "div",
        { className: "dsh-ps-setting" },
        h(
          "div",
          null,
          h("div", { className: "dsh-ps-setting-title" }, "输入框内联预测"),
          h("div", { className: "dsh-ps-setting-desc" }, "空输入框且空闲时，框内以灰字预测你的下一句；Tab 接受，↑ 调出本会话发过的 prompt。关闭后不再请求模型。"),
        ),
        h("input", {
          type: "checkbox",
          checked: enabled,
          onChange: (event) => setEnabled(event.target.checked),
        }),
      );
    }

    function apply(ctx) {
      ensureStyle();
      const status = { overlay: false, settings: false, settingsError: null };
      const register = (options, component, key) => {
        let dispose;
        let attempts = 0;
        const attempt = () => {
          try {
            dispose = ctx.slots.register(options, component);
            status[key] = true;
          } catch (error) {
            attempts += 1;
            if (key === "settings") status.settingsError = error && error.message ? error.message : String(error);
            if (attempts < 60) setTimeout(attempt, 500);
            return;
          }
          if (typeof ctx.effect === "function") {
            ctx.effect(() => () => {
              if (typeof dispose === "function") dispose();
            });
          }
        };
        attempt();
      };
      register({ name: "conversation.input.overlay", id: "prompt-suggest", order: 20 }, Ghost, "overlay");
      register({ name: "settings.section", id: "prompt-suggest", order: 900, label: "输入框内联预测" }, SettingsSection, "settings");
      setTimeout(() => {
        post({ method: "diag", payload: { version: "v3", status } }).catch(() => {});
      }, 2500);
    }

    exports.apply = apply;
    exports.inject = ["slots", "conversation"];
    return module.exports;
  },
});
