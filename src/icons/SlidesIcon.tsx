import { IconBase, type IconProps } from "./IconBase";

export function SlidesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M8 20h8" />
    </IconBase>
  );
}
