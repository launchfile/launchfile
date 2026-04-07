export interface NavItem {
  title: string;
  href: string;
  external?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const navigation: NavGroup[] = [
  {
    title: "Getting Started",
    items: [
      { title: "Installation", href: "/installation/" },
    ],
  },
  {
    title: "Guides",
    items: [
      { title: "Quick Start", href: "/quick-start/" },
      { title: "Writing a Launchfile", href: "/writing-a-launchfile/" },
      { title: "Examples", href: "/examples/" },
    ],
  },
  {
    title: "SDK",
    items: [{ title: "SDK Reference", href: "/sdk/" }],
  },
  {
    title: "Resources",
    items: [
      {
        title: "Specification",
        href: "https://launchfile.org/spec/",
        external: true,
      },
      {
        title: "App Catalog",
        href: "https://launchfile.io",
        external: true,
      },
      {
        title: "GitHub",
        href: "https://github.com/launchfile/launchfile",
        external: true,
      },
    ],
  },
];

const flatPages = navigation
  .flatMap((g) => g.items)
  .filter((p) => !p.external);

export function getPrevPage(currentPath: string): NavItem | undefined {
  const idx = flatPages.findIndex((p) => p.href === currentPath);
  return idx > 0 ? flatPages[idx - 1] : undefined;
}

export function getNextPage(currentPath: string): NavItem | undefined {
  const idx = flatPages.findIndex((p) => p.href === currentPath);
  return idx >= 0 && idx < flatPages.length - 1
    ? flatPages[idx + 1]
    : undefined;
}
