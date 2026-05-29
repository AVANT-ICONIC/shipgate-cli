import path from "node:path";

export function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function resolveLocalPath(
  baseRoot: string,
  value: string,
  label: string,
  allowedRoot = baseRoot
): string {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty.`);
  }

  if (value.includes("\0")) {
    throw new Error(`${label} must not contain null bytes.`);
  }

  if (isAbsolutePath(value)) {
    throw new Error(`${label} must be a relative path.`);
  }

  const resolved = path.resolve(baseRoot, value);
  if (!isInsidePath(allowedRoot, resolved)) {
    throw new Error(`${label} must resolve inside ${allowedRoot}. Got ${resolved}.`);
  }

  return resolved;
}

export function pathValidationError(
  baseRoot: string,
  value: string,
  label: string,
  allowedRoot = baseRoot
): string | undefined {
  try {
    resolveLocalPath(baseRoot, value, label, allowedRoot);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
