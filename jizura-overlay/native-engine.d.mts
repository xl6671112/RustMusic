declare const J: {
  defaultProject(): Record<string, any>;
  plan(project: Record<string, any>, audio?: Record<string, any>): Record<string, any>;
  lineSnapshot(plan: Record<string, any>, index: number): Record<string, any>[] | null;
  omakase(project: Record<string, any>, random?: () => number, themeId?: string | null): Record<string, any>;
  h(...values: number[]): number;
  RustMusic: {
    projectForState(project: Record<string, any> | undefined, state: Record<string, any>): Record<string, any>;
  };
  [key: string]: any;
};
export default J;
