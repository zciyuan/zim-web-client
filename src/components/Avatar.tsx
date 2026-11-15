import { avatarHue, initialOf } from '../app/format';

interface AvatarProps {
  name: string;
  seed: string | number;
  size?: number;
}

export function Avatar({ name, seed, size = 38 }: AvatarProps) {
  return (
    <div
      aria-hidden
      className="grid shrink-0 select-none place-items-center rounded-xl font-bold text-white"
      style={{
        width: size,
        height: size,
        background: `hsl(${avatarHue(seed)} 62% 52%)`,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {initialOf(name)}
    </div>
  );
}
