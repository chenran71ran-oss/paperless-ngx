import { HttpClient } from '@angular/common/http'
import {
  Component,
  ElementRef,
  Input,
  Output,
  EventEmitter,
  ViewChild,
  OnChanges,
  OnDestroy,
  AfterViewInit,
  inject,
  NgZone,
  signal,
} from '@angular/core'
import { firstValueFrom } from 'rxjs'
import { AnnotationSession } from './annotation-session.service'
import { EmbedPdfAdapter } from './embedpdf.adapter'

@Component({
  selector: 'pngx-research-pdf',
  template:
    '<div #mount class="pdf-mount"></div>@if(error()){<p class="pdf-error" role="alert">{{error()}}</p>}',
  styles:
    ':host{display:block;height:100%;position:relative;min-width:0}.pdf-mount{height:100%;width:100%;overflow:hidden}.pdf-error{position:absolute;inset:0 auto auto 0;background:var(--pngx-bg-alt);color:var(--bs-body-color);padding:.6rem;max-width:100%}',
})
export class ResearchPdfComponent
  implements OnChanges, OnDestroy, AfterViewInit
{
  @Input() source = ''
  @Input() endpoint = ''
  @Input() selector = 'original'
  @Input() user = ''
  @Input() page = 1
  @Input() zoom = 1
  @Input() searchQuery = ''
  @Input() scroll = 0
  @Input() rotation = 0
  @Output() pageChange = new EventEmitter<number>()
  @Output() loaded = new EventEmitter<number>()
  @Output() selected = new EventEmitter<void>()
  @ViewChild('mount', { static: true }) mount!: ElementRef<HTMLElement>
  private http = inject(HttpClient)
  private zone = inject(NgZone)
  private session = inject(AnnotationSession)
  private adapter?: EmbedPdfAdapter
  private initialized = false
  private generation = 0
  private reloadSubscription = this.session.restart.subscribe(() => {
    void this.open()
  })
  error = signal('')
  ngAfterViewInit() {
    this.initialized = true
    void this.open()
  }
  ngOnChanges(changes) {
    if (!this.initialized) return
    if (changes.source || changes.selector || changes.endpoint) {
      void this.open()
      return
    }
    if (changes.page) this.adapter?.navigate(this.page)
    if (changes.zoom) this.adapter?.zoom(Number(this.zoom))
    if (changes.searchQuery) this.adapter?.search(this.searchQuery)
    if (changes.rotation) this.adapter?.setRotation(this.rotation)
  }
  private async open() {
    const generation = ++this.generation
    this.adapter?.destroy()
    this.session.detach()
    this.error.set('')
    const versionTask = this.session.activate(
      this.endpoint,
      this.selector,
      this.user
    )
    try {
      const content = await firstValueFrom(
        this.http.get(this.source, { responseType: 'arraybuffer' })
      )
      if (generation !== this.generation) return
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', content))
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      const adapter = (this.adapter = new EmbedPdfAdapter(
        this.mount.nativeElement,
        (change) => this.zone.run(() => this.session.change(change)),
        (id) =>
          this.zone.run(() => {
            this.session.select(id)
            this.selected.emit()
          }),
        (page) =>
          this.zone.run(() => {
            if (page !== this.page) this.pageChange.emit(page)
          }),
        () => this.zone.run(() => this.session.refreshCapabilities()),
        (message) =>
          this.zone.run(() => {
            this.error.set(message)
          })
      ))
      const pages = await adapter.open(
        content,
        this.page,
        Number(this.zoom),
        this.rotation
      )
      if (generation !== this.generation) return
      adapter.restoreScroll(this.scroll)
      this.zone.run(() => this.loaded.emit(pages))
      const version = await versionTask
      if (generation === this.generation && version)
        this.zone.run(() => this.session.bind(adapter, sha))
    } catch {
      if (generation === this.generation)
        this.zone.run(() => {
          this.error.set('PDF加载失败，请检查权限或刷新重试')
        })
    }
  }
  ngOnDestroy() {
    ++this.generation
    this.adapter?.destroy()
    this.session.detach()
    this.reloadSubscription.unsubscribe()
  }
}
