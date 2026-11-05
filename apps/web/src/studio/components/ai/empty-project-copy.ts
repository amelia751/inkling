import { NAMING } from "@studio/contracts/naming";

/** What an empty project's chat says, in the assistant panel and on the page. */
export function emptyProjectCopy(title: string) {
  return {
    title: `What do you want to do in ${title}?`,
    description: `Attach files or a whole folder and ${NAMING.displayName} uploads them, sorts them by type and sets up a Studio for each. Then ask for what you need, like prelabeling objects with SAM 3.1.`,
    example: "Prelabel the lungs in these chest X-rays",
  };
}
