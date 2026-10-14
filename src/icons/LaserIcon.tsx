import { IconBase, type IconProps } from "./IconBase";

export function LaserIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="17" cy="7" r="2.5" />
      <path d="M15 9 4 20M19.5 4.5l1-1M21 7h1.5M17 3V1.5" />
    </IconBase>
  );
}
