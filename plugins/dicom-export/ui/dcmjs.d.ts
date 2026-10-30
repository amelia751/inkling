/** dcmjs ships no types; aliased in vite.config.ts to @cornerstonejs/adapters' copy. */
declare module "dcmjs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const data: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dcmjs: any;
  export default dcmjs;
}
