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
    title: "Learn",
    items: [
      { title: "Course Overview", href: "/learn/" },
      { title: "1. Your First Launchfile", href: "/learn/first-launchfile/" },
      { title: "2. Adding a Database", href: "/learn/adding-a-database/" },
      { title: "3. Env Vars & Secrets", href: "/learn/env-and-secrets/" },
      { title: "4. Ports, Storage & Health", href: "/learn/ports-storage-health/" },
      { title: "5. Lifecycle Commands", href: "/learn/lifecycle-commands/" },
      { title: "6. Multi-Component Apps", href: "/learn/multi-component/" },
      { title: "7. Specialized Patterns", href: "/learn/specialized-patterns/" },
    ],
  },
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
