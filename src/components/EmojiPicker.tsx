// Compact emoji picker: unicode only, so no asset pipeline and no licensing.
// Insertion happens at the caret position owned by the composer.

const GROUPS: { title: string; items: string[] }[] = [
  {
    title: '常用',
    items: ['😀', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉', '😊', '😍', '😘', '😜', '😎', '🤔', '😐', '😴', '😭', '😡', '🥳'],
  },
  {
    title: '手势',
    items: ['👍', '👎', '👌', '✌️', '🤝', '👏', '🙏', '💪', '👋', '🫶', '🤙', '✋'],
  },
  {
    title: '物品',
    items: ['❤️', '💔', '🔥', '✨', '🎉', '🎁', '☕', '🍺', '🌹', '⭐', '💯', '✅', '❌', '⚠️', '📎', '📷'],
  },
];

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
  return (
    <div
      className="absolute bottom-16 left-3 z-30 w-[320px] rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      role="dialog"
      aria-label="表情"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">表情</span>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
          关闭
        </button>
      </div>
      <div className="max-h-[220px] overflow-y-auto">
        {GROUPS.map((group) => (
          <div key={group.title} className="mb-2">
            <p className="mb-1 text-[11px] text-slate-400">{group.title}</p>
            <div className="grid grid-cols-10 gap-0.5">
              {group.items.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onPick(emoji)}
                  className="grid h-7 w-7 place-items-center rounded-md text-lg transition hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label={emoji}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
