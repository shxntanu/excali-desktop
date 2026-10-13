# Excali Desktop

## Register
product

## Platform
web

The interface is a React webview inside a Tauri desktop application.

## Product Purpose
A fast, offline Excalidraw wrapper that opens and saves local drawings, several at once in tabs, and presents their frames as slides with transitions and builds. Version history is a later milestone.

## Users
People drawing and editing diagrams on their desktop who need local file persistence.

## Design Principles
Keep the drawing surface central. Make file actions visible. Protect unsaved work. Keep the application usable without a network connection.

## Implementation direction
A native-feeling window: overlay title bar with inset traffic lights, a translucent macOS sidebar for file actions, and the canvas filling the rest. Borrow Excalidraw's own tokens (Assistant font, #6965db primary, surface colors) and follow the system light/dark appearance. Keep copy to labels only. Keyboard access, visible focus, and reduced motion are implementation defaults.
