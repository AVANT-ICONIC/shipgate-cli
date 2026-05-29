import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relOrAbs(from: string, target: string): string {
  const rel = path.relative(from, target);
  return rel && !rel.startsWith("..") ? rel : target;
}
