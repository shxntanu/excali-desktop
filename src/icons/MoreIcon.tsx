import { IconBase, type IconProps } from "./IconBase";

export function MoreIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.5" />
    </IconBase>
  );
}
