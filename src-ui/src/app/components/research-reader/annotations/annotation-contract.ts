export interface PdfVersion {
  id: string
  sha256: string
  kind: string
  pages: { width: number; height: number }[]
}
export interface AnnotationRecord {
  schema_version: 1
  id: string
  type: 'highlight' | 'underline' | 'rectangle' | 'ink' | 'text'
  page: number
  coordinate_system: 'pdf-points-top-left-unrotated'
  regions: { x: number; y: number; width: number; height: number }[]
  quote: string
  comment: string
  color: string
  revision?: number
  deleted?: boolean
  sdk: {
    format: 'embedpdf-v2'
    version: '2.15.1'
    data: Record<string, unknown>
  }
}
export interface AnnotationChange {
  action: 'create' | 'update' | 'delete'
  annotation: AnnotationRecord
}
export interface ReaderCapabilities {
  annotations: boolean
  export: boolean
  search: boolean
  undo: boolean
  redo: boolean
}
export interface PdfReaderPort {
  open(
    buffer: ArrayBuffer,
    page: number,
    zoom: number,
    rotation?: number
  ): Promise<number>
  destroy(): void
  navigate(page: number): void
  zoom(level: number): void
  rotate(): void
  search(query: string): void
  tool(name: string | null): void
  loadAnnotations(records: AnnotationRecord[]): void
  focus(record: AnnotationRecord): void
  comment(record: AnnotationRecord, value: string, notify?: boolean): void
  remove(record: AnnotationRecord): void
  color(record: AnnotationRecord, value: string): void
  undo(): void
  redo(): void
  exportCopy(): Promise<ArrayBuffer>
  capabilities(): ReaderCapabilities
  scrollPosition(): number
  restoreScroll(offset: number): void
  rotation(): number
  setRotation(value: number): void
}
