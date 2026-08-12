import { useCallback, useMemo, useState } from "react";
import {
  ClipboardPaste,
  Copy,
  Home,
  Scissors,
  Settings,
  TextSelect,
} from "lucide-react";
import * as Ctx from "./ContextMenu";

const TEXT_INPUT_TYPES = new Set([
  "email",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

function findTextControl(target) {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest("textarea, input, [contenteditable='true'], [contenteditable='plaintext-only']");
  if (candidate instanceof HTMLTextAreaElement) return candidate;
  if (candidate instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(candidate.type)) return candidate;
  if (candidate instanceof HTMLElement && candidate.isContentEditable) return candidate;
  return null;
}

function readContext(target) {
  const control = findTextControl(target);
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    const start = control.selectionStart ?? 0;
    const end = control.selectionEnd ?? start;
    return {
      control,
      editable: !control.disabled && !control.readOnly,
      end,
      range: null,
      selectedText: control.value.slice(start, end),
      start,
    };
  }

  if (control?.isContentEditable) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    return {
      control,
      editable: true,
      end: null,
      range,
      selectedText: selection?.toString() ?? "",
      start: null,
    };
  }

  return {
    control: null,
    editable: false,
    end: null,
    range: null,
    selectedText: window.getSelection()?.toString() ?? "",
    start: null,
  };
}

async function writeClipboard(text) {
  if (!text) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the compatibility path for desktop webviews.
    }
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  return copied;
}

async function readClipboard() {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function restoreContentEditableRange(context) {
  const { control, range } = context;
  if (!(control instanceof HTMLElement) || !range) return null;
  control.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function replaceSelection(context, text, inputType) {
  const { control, start, end } = context;

  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    control.focus();
    control.setRangeText(text, start ?? 0, end ?? start ?? 0, "end");
    control.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: text || null,
      inputType,
    }));
    return;
  }

  const range = restoreContentEditableRange(context);
  if (!range) return;
  range.deleteContents();
  if (text) {
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  control.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: text || null,
    inputType,
  }));
}

function selectAll(context) {
  const { control } = context;
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    control.focus();
    control.setSelectionRange(0, control.value.length);
    return;
  }

  if (control instanceof HTMLElement) {
    control.focus();
    const range = document.createRange();
    range.selectNodeContents(control);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

export default function GlobalContextMenu({
  children,
  newTabOptions = [],
  onOpenHome,
  onOpenSettings,
}) {
  const [context, setContext] = useState(() => readContext(null));

  const handleContextMenu = useCallback((event) => {
    setContext(readContext(event.target));
  }, []);

  const canPaste = context.editable && typeof navigator.clipboard?.readText === "function";
  const hasSelection = context.selectedText.length > 0;
  const showEditActions = Boolean(context.control) || hasSelection;

  const handleCopy = useCallback(async () => {
    await writeClipboard(context.selectedText);
  }, [context.selectedText]);

  const handleCut = useCallback(async () => {
    if (!context.editable || !context.selectedText) return;
    if (await writeClipboard(context.selectedText)) {
      replaceSelection(context, "", "deleteByCut");
    }
  }, [context]);

  const handlePaste = useCallback(async () => {
    if (!context.editable) return;
    const text = await readClipboard();
    if (text !== null) replaceSelection(context, text, "insertFromPaste");
  }, [context]);

  const handleCloseAutoFocus = useCallback((event) => {
    if (!context.control?.isConnected) return;
    event.preventDefault();
    window.requestAnimationFrame(() => context.control?.focus({ preventScroll: true }));
  }, [context.control]);

  const workspaceItems = useMemo(() => newTabOptions.filter(Boolean), [newTabOptions]);

  return (
    <Ctx.Root>
      <Ctx.Trigger onContextMenu={handleContextMenu}>{children}</Ctx.Trigger>
      <Ctx.Content
        aria-label="Cortex Studio context menu"
        className="ctx-menu-content--global"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        {showEditActions ? (
          <>
            <Ctx.Label>Edit</Ctx.Label>
            <Ctx.Item disabled={!context.editable || !hasSelection} onSelect={handleCut}>
              <Scissors aria-hidden="true" />
              <span>Cut</span>
              <Ctx.Shortcut>Ctrl+X</Ctx.Shortcut>
            </Ctx.Item>
            <Ctx.Item disabled={!hasSelection} onSelect={handleCopy}>
              <Copy aria-hidden="true" />
              <span>Copy</span>
              <Ctx.Shortcut>Ctrl+C</Ctx.Shortcut>
            </Ctx.Item>
            <Ctx.Item disabled={!canPaste} onSelect={handlePaste}>
              <ClipboardPaste aria-hidden="true" />
              <span>Paste</span>
              <Ctx.Shortcut>Ctrl+V</Ctx.Shortcut>
            </Ctx.Item>
            {context.control ? (
              <>
                <Ctx.Separator />
                <Ctx.Item onSelect={() => selectAll(context)}>
                  <TextSelect aria-hidden="true" />
                  <span>Select all</span>
                  <Ctx.Shortcut>Ctrl+A</Ctx.Shortcut>
                </Ctx.Item>
              </>
            ) : null}
          </>
        ) : (
          <>
            <Ctx.Label>Workspace</Ctx.Label>
            <Ctx.Item onSelect={onOpenHome}>
              <Home aria-hidden="true" />
              <span>Home</span>
            </Ctx.Item>
            {workspaceItems.map(({ icon: Icon, id, label, onSelect, shortcut }) => (
              <Ctx.Item key={id} onSelect={onSelect}>
                {Icon ? <Icon aria-hidden="true" /> : null}
                <span>{label}</span>
                {shortcut ? <Ctx.Shortcut>{shortcut}</Ctx.Shortcut> : null}
              </Ctx.Item>
            ))}
            <Ctx.Separator />
            <Ctx.Item onSelect={onOpenSettings}>
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </Ctx.Item>
          </>
        )}
      </Ctx.Content>
    </Ctx.Root>
  );
}
