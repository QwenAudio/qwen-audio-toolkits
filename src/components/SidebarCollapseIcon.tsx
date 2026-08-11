interface SidebarCollapseIconProps {
  collapsed?: boolean
}

export function SidebarCollapseIcon({
  collapsed = false,
}: SidebarCollapseIconProps) {
  return (
    <svg
      className="sidebar-collapse-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.75" />
      {collapsed ? (
        <path d="M4.75 5v6" />
      ) : (
        <path d="M6.75 2.25v11.5" />
      )}
    </svg>
  )
}
