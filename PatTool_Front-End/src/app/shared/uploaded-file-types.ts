/** Fichier tableur OpenDocument Calc (.ods). */
export function isOdsFile(fileName: string | undefined | null): boolean {
  if (!fileName) {
    return false;
  }
  return fileName.toLowerCase().endsWith('.ods');
}
