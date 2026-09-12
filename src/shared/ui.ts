/**
 * Typed messaging between the UI surfaces and the service worker,
 * plus the toast/modal helpers every surface uses.
 */
import type { Message, MessageResponse } from "./types"
import { h, icon, $ } from "./dom"

/** Sends a message to the service worker and unwraps the envelope. */
export async function send<T = unknown>(msg: Message): Promise<MessageResponse<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as MessageResponse<T> | undefined
    if (!res) return { ok: false, error: "No response from the background worker" }
    return res
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Sends and throws on failure, for call sites that only handle the happy path. */
export async function must<T = unknown>(msg: Message): Promise<T> {
  const res = await send<T>(msg)
  if (!res.ok) throw new Error(res.error ?? "Request failed")
  return res.data as T
}

/* ------------------------------------------------------------------ */
/* Toasts                                                             */
/* ------------------------------------------------------------------ */

function toastRoot(): HTMLElement {
  let root = $(".toast-wrap")
  if (!root) {
    root = h("div", { class: "toast-wrap" })
    document.body.appendChild(root)
  }
  return root
}

export type ToastKind = "ok" | "err" | "warn" | "info"

export function toast(message: string, kind: ToastKind = "info", ms = 2600): void {
  const iconName = kind === "ok" ? "check" : kind === "err" ? "x" : kind === "warn" ? "info" : "info"
  const node = h(
    "div",
    { class: `toast ${kind}`, role: "status" },
    icon(iconName, 15),
    h("span", { class: "truncate", text: message }),
  )
  toastRoot().appendChild(node)
  setTimeout(() => {
    node.classList.add("out")
    setTimeout(() => node.remove(), 200)
  }, ms)
}

/* ------------------------------------------------------------------ */
/* Modal                                                              */
/* ------------------------------------------------------------------ */

export interface ModalOptions {
  title: string
  /** body content; a string is treated as text */
  body: Node | string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** hide the cancel button for pure acknowledgement dialogs */
  alertOnly?: boolean
  onConfirm?: () => void | Promise<void>
}

/** Returns a promise that resolves true when confirmed. */
export function modal(opts: ModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const body = typeof opts.body === "string" ? h("div", { text: opts.body }) : opts.body

    const close = (result: boolean) => {
      backdrop.remove()
      document.removeEventListener("keydown", onKey)
      resolve(result)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false)
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        void confirm()
      }
    }

    const confirmBtn = h("button", {
      class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`,
      text: opts.confirmText ?? "Confirm",
      on: { click: () => void confirm() },
    })

    async function confirm() {
      if (opts.onConfirm) {
        confirmBtn.disabled = true
        try {
          await opts.onConfirm()
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), "err")
          confirmBtn.disabled = false
          return
        }
      }
      close(true)
    }

    const backdrop = h(
      "div",
      {
        class: "modal-backdrop",
        on: {
          mousedown: (e: Event) => {
            if (e.target === backdrop) close(false)
          },
        },
      },
      h(
        "div",
        { class: "modal", role: "dialog", "aria-modal": "true" },
        h(
          "div",
          { class: "modal-head" },
          h("h2", { class: "modal-title", text: opts.title }),
        ),
        h("div", { class: "modal-body" }, body),
        h(
          "div",
          { class: "modal-foot" },
          opts.alertOnly
            ? null
            : h("button", {
                class: "btn",
                text: opts.cancelText ?? "Cancel",
                on: { click: () => close(false) },
              }),
          confirmBtn,
        ),
      ),
    )

    document.body.appendChild(backdrop)
    document.addEventListener("keydown", onKey)
    setTimeout(() => confirmBtn.focus(), 30)
  })
}

/** A simple prompt dialog. Resolves null when cancelled. */
export function promptModal(opts: {
  title: string
  label?: string
  value?: string
  placeholder?: string
  confirmText?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const input = h("input", {
      class: "input",
      value: opts.value ?? "",
      placeholder: opts.placeholder ?? "",
      spellcheck: false,
    })

    const body = h(
      "div",
      { class: "field" },
      opts.label ? h("label", { class: "label", text: opts.label }) : null,
      input,
    )

    const backdrop = h(
      "div",
      {
        class: "modal-backdrop",
        on: {
          mousedown: (e: Event) => {
            if (e.target === backdrop) finish(null)
          },
        },
      },
      h(
        "div",
        { class: "modal" },
        h("div", { class: "modal-head" }, h("h2", { class: "modal-title", text: opts.title })),
        h("div", { class: "modal-body" }, body),
        h(
          "div",
          { class: "modal-foot" },
          h("button", { class: "btn", text: "Cancel", on: { click: () => finish(null) } }),
          h("button", {
            class: "btn btn-primary",
            text: opts.confirmText ?? "Save",
            on: { click: () => finish(input.value.trim() || null) },
          }),
        ),
      ),
    )

    function finish(v: string | null) {
      if (settled) return
      settled = true
      backdrop.remove()
      document.removeEventListener("keydown", onKey)
      resolve(v)
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") finish(null)
      if (e.key === "Enter") finish(input.value.trim() || null)
    }

    document.body.appendChild(backdrop)
    document.addEventListener("keydown", onKey)
    setTimeout(() => {
      input.focus()
      input.select()
    }, 30)
  })
}
