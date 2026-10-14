import { IconBase, type IconProps } from "./IconBase";

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h8M16 7h4M4 17h2M10 17h10" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </IconBase>
  );
}
