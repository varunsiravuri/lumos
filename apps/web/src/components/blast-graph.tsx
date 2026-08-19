"use client";

export interface GraphNode {
  id: string;
  label: string;
  path: string;
  depth: number;
  isTest: boolean;
}

export interface GraphLink {
  from: string;
  to: string;
  type: string;
}

interface Props {
  seed: string;
  nodes: GraphNode[];
  links: GraphLink[];
  selected: string | null;
  onSelect: (id: string) => void;
}

function shortName(qualname: string): string {
  const parts = qualname.split(".");
  return parts.slice(-2).join(".");
}

export function BlastGraph({ seed, nodes, links, selected, onSelect }: Props) {
  const production = nodes.filter((node) => !node.isTest);
  const depths = [...new Set(production.map((node) => node.depth))].sort((a, b) => a - b);
  const colW = 215;
  const rowH = 68;
  const padX = 28;
  const padY = 48;

  const columns = depths.map((depth) => production.filter((node) => node.depth === depth).slice(0, 9));
  const height = padY * 2 + Math.max(3, ...columns.map((col) => col.length)) * rowH;
  const width = padX * 2 + Math.max(1, columns.length) * colW;

  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, colIndex) => {
    col.forEach((node, row) => {
      pos.set(node.id, {
        x: padX + colIndex * colW + 8,
        y: padY + row * rowH,
      });
    });
  });

  const neighbors = new Set<string>();
  if (selected) {
    neighbors.add(selected);
    for (const link of links) {
      if (link.from === selected) neighbors.add(link.to);
      if (link.to === selected) neighbors.add(link.from);
    }
  }

  return (
    <div className="blast-graph-surface h-full overflow-auto bg-inset">
      <svg
        role="img"
        aria-label={`Callers of ${seed}`}
        width={width}
        height={height}
        className="block min-h-full"
      >
        {links.map((link) => {
          const a = pos.get(link.from);
          const b = pos.get(link.to);
          if (!a || !b) return null;
          const x1 = a.x;
          const y1 = a.y + 19;
          const x2 = b.x + 178;
          const y2 = b.y + 19;
          const mid = (x1 + x2) / 2;
          const active = !selected || neighbors.has(link.from) || neighbors.has(link.to);
          return (
            <path
              key={`${link.from}-${link.to}-${link.type}`}
              d={`M ${x2} ${y2} C ${mid} ${y2}, ${mid} ${y1}, ${x1} ${y1}`}
              fill="none"
              stroke={link.type === "COVERS" ? "var(--lexical)" : "var(--accent)"}
              strokeWidth={active ? 1.25 : 0.6}
              opacity={active ? 0.85 : 0.18}
            />
          );
        })}
        {columns.map((col, colIndex) =>
          col.map((node, row) => {
            const point = pos.get(node.id);
            if (!point) return null;
            const isSeed = node.id === seed;
            const isSel = node.id === selected;
            const dim = selected !== null && !neighbors.has(node.id);
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}, ${node.path}`}
                className="lamp cursor-pointer outline-none focus-visible:[&>rect:first-of-type]:stroke-[2.5]"
                style={{ animationDelay: `${colIndex * 70 + row * 24}ms` }}
                transform={`translate(${point.x}, ${point.y})`}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                <rect
                  width="178"
                  height="42"
                  rx="5"
                  fill={isSeed || isSel ? "var(--panel)" : "var(--background)"}
                  stroke={isSeed || isSel ? "var(--accent)" : "var(--line)"}
                  strokeWidth={isSeed ? 1.5 : 1}
                  opacity={dim ? 0.28 : 1}
                />
                <text
                  x="8"
                  y="17"
                  fill="var(--foreground)"
                  fontFamily="var(--font-mono), ui-monospace, monospace"
                  fontSize="11"
                >
                  {shortName(node.label)}
                </text>
                <text
                  x="8"
                  y="32"
                  fill="var(--muted)"
                  fontFamily="var(--font-mono), ui-monospace, monospace"
                  fontSize="9"
                >
                  {node.path.split("/").slice(-2).join("/")}
                </text>
                <rect
                  width="178"
                  height="42"
                  rx="5"
                  fill="transparent"
                >
                  <title>{node.label}</title>
                </rect>
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}
