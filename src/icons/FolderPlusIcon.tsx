import { IconBase, type IconProps } from "./IconBase";

export function FolderPlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
      <path d="M12 10v6M9 13h6" />
    </IconBase>
  );
}
