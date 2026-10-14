import { IconBase, type IconProps } from "./IconBase";

export function FrameIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h16M4 17h16M7 4v16M17 4v16" />
    </IconBase>
  );
}
