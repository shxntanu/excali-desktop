import { IconBase, type IconProps } from "./IconBase";

export function RobotIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="7" width="14" height="13" rx="3" />
      <path d="M12 3v4M2 12v4M22 12v4M9 16h6" />
      <circle cx="9" cy="12" r=".75" />
      <circle cx="15" cy="12" r=".75" />
    </IconBase>
  );
}
