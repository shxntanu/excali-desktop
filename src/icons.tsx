import { CloseIcon } from "./icons/CloseIcon";
import { DownIcon } from "./icons/DownIcon";
import { FileIcon } from "./icons/FileIcon";
import { FolderIcon } from "./icons/FolderIcon";
import { FolderPlusIcon } from "./icons/FolderPlusIcon";
import { FrameIcon } from "./icons/FrameIcon";
import { KeyboardIcon } from "./icons/KeyboardIcon";
import { LaserIcon } from "./icons/LaserIcon";
import { MoonIcon } from "./icons/MoonIcon";
import { MoreIcon } from "./icons/MoreIcon";
import { NewIcon } from "./icons/NewIcon";
import { NextIcon } from "./icons/NextIcon";
import { OpenIcon } from "./icons/OpenIcon";
import { PencilIcon } from "./icons/PencilIcon";
import { PlayIcon } from "./icons/PlayIcon";
import { PlusIcon } from "./icons/PlusIcon";
import { PreviousIcon } from "./icons/PreviousIcon";
import { RobotIcon } from "./icons/RobotIcon";
import { SaveIcon } from "./icons/SaveIcon";
import { SaveAsIcon } from "./icons/SaveAsIcon";
import { SettingsIcon } from "./icons/SettingsIcon";
import { SidebarIcon } from "./icons/SidebarIcon";
import { SkipIcon } from "./icons/SkipIcon";
import { SlidesIcon } from "./icons/SlidesIcon";
import { SunIcon } from "./icons/SunIcon";
import { UpIcon } from "./icons/UpIcon";
import type { IconProps } from "./icons/IconBase";

const icons = {
  close: CloseIcon,
  down: DownIcon,
  file: FileIcon,
  folder: FolderIcon,
  folderPlus: FolderPlusIcon,
  frame: FrameIcon,
  keyboard: KeyboardIcon,
  laser: LaserIcon,
  moon: MoonIcon,
  more: MoreIcon,
  new: NewIcon,
  next: NextIcon,
  open: OpenIcon,
  pencil: PencilIcon,
  play: PlayIcon,
  plus: PlusIcon,
  previous: PreviousIcon,
  robot: RobotIcon,
  save: SaveIcon,
  saveAs: SaveAsIcon,
  settings: SettingsIcon,
  sidebar: SidebarIcon,
  skip: SkipIcon,
  slides: SlidesIcon,
  sun: SunIcon,
  up: UpIcon,
};

export type IconName = keyof typeof icons;

export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  const Component = icons[name];
  return <Component {...props} />;
}
