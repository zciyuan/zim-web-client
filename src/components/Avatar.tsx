import { avatarHue, initialOf } from '../app/format';

interface AvatarProps {
  name: string;
  seed: string | number;
  size?: number;
  /** undefined hides the dot; true/false renders green/grey. */
  online?: boolean;
}

export function Avatar({ name, seed, size = 38, online }: AvatarProps) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        aria-hidden
        className="grid h-full w-full select-none place-items-center rounded-xl font-bold text-white"
        style={{
          background: `hsl(${avatarHue(seed)} 62% 52%)`,
          fontSize: Math.round(size * 0.42),
        }}
      >
        {initialOf(name)}
      </div>
      {online === undefined ? null : (
        <span
          data-online={online ? 'true' : 'false'}
          title={online ? '在线' : '离线'}
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-white dark:border-slate-900 ${
            online ? 'bg-emerald-500' : 'bg-slate-400'
          }`}
          style={{ width: Math.max(8, Math.round(size * 0.28)), height: Math.max(8, Math.round(size * 0.28)) }}
        />
      )}
    </div>
  );
}
