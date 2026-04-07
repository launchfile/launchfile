export interface NavItem {
  title: string;
  href: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const navigation: NavGroup[] = [
  {
    title: "Specification",
    items: [
      { title: "Overview", href: "/spec/" },
      { title: "Quick Start", href: "/spec/quick-start/" },
      { title: "Top-Level Fields", href: "/spec/top-level-fields/" },
      { title: "Components", href: "/spec/components/" },
      { title: "Provides", href: "/spec/provides/" },
      { title: "Requires", href: "/spec/requires/" },
      { title: "Supports", href: "/spec/supports/" },
      { title: "Secrets", href: "/spec/secrets/" },
      { title: "Environment Variables", href: "/spec/environment-variables/" },
      { title: "Commands", href: "/spec/commands/" },
      { title: "Health", href: "/spec/health/" },
      { title: "Build", href: "/spec/build/" },
      { title: "Storage", href: "/spec/storage/" },
      { title: "Depends On", href: "/spec/depends-on/" },
      { title: "Host", href: "/spec/host/" },
      { title: "Other Fields", href: "/spec/other-fields/" },
    ],
  },
  {
    title: "Concepts",
    items: [
      { title: "Value Patterns", href: "/spec/value-patterns/" },
      { title: "Expression Syntax", href: "/spec/expression-syntax/" },
      {
        title: "Resource Properties",
        href: "/spec/resource-property-vocabulary/",
      },
      { title: "YAML Compatibility", href: "/spec/yaml-compatibility/" },
      { title: "Extensibility", href: "/spec/extensibility/" },
    ],
  },
  {
    title: "Design",
    items: [
      { title: "Why Launchfile", href: "/why/" },
      { title: "Design Principles", href: "/design/" },
      { title: "Contributing", href: "/contributing/" },
      { title: "Known Gaps", href: "/gaps/" },
    ],
  },
];

const flatPages = navigation.flatMap((g) => g.items);

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
