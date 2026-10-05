import type { ReactNode } from 'react';

export type RightRailProps = {
  readonly children: ReactNode;
};

/** Layout-only rail: stacks the rail's sections with even gaps. */
export function RightRail({ children }: RightRailProps) {
  return (
    <div className="flex h-full flex-col gap-8 overflow-y-auto px-5 pt-6 pb-10 max-rail:grid max-rail:h-auto max-rail:grid-cols-rail-sections max-rail:gap-x-10 max-rail:overflow-visible max-rail:p-6">
      {children}
    </div>
  );
}
