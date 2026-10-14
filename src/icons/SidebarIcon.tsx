import { IconBase, type IconProps } from "./IconBase";

export function SidebarIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16" />
    </IconBase>
  );
}
