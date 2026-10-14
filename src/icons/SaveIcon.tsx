import { IconBase, type IconProps } from "./IconBase";

export function SaveIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 4h10l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
      <circle cx="12" cy="14" r="2" />
      <path d="M14 4v4H8V4" />
    </IconBase>
  );
}
