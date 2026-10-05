import { prose } from './prose-class';
type RouteShellProps = {
  readonly title: string;
  readonly lede: string;
  readonly planned: readonly string[];
};

/**
 * Presentation shell for product areas that have no implementation yet.
 * Replace it inside one owning feature when that area comes alive.
 */
export function RouteShell({ title, lede, planned }: RouteShellProps) {
  return (
    <section>
      <h1 className={prose.h1}>{title}</h1>
      <p className={prose.p}>{lede}</p>
      <h2 className={prose.h2}>Planned capabilities</h2>
      <ul className={prose.ul}>
        {planned.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
