import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
} from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { FormsModule } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { Subject, takeUntil } from 'rxjs'
import { environment } from 'src/environments/environment'
interface Candidate {
  id: string
  source: string
  arxiv_id: string
  status: string
  task_id: string
  document_id: number | null
  to_read: boolean
  has_pdf: boolean
  metadata: Record<string, string>
}
@Component({
  selector: 'pngx-research-discovery',
  imports: [FormsModule, RouterLink],
  template: `
    <header>
      <h2>论文发现与导入</h2>
      <button (click)="load()">刷新</button>
    </header>
    <p class="small text-muted">
      arXiv只在手动点击时获取公开元数据，不调用模型；来源未提供的机构信息不作推断。候选不是Paperless文档，归档完成后才进入统一阅读页。
    </p>
    <section class="controls">
      <label
        >arXiv分区<input
          aria-label="arXiv分区"
          [(ngModel)]="category"
          placeholder="cs.AI" /></label
      ><label
        >关键词<input aria-label="arXiv关键词" [(ngModel)]="keyword" /></label
      ><button [disabled]="busy" (click)="fetch()">获取最新arXiv</button>
    </section>
    <details class="import-block">
      <summary>Zotero RDF与PDF附件导入</summary>
      <p>
        上传不超过8MiB的ZIP，包含一份Zotero
        RDF和其PDF附件。先预检候选，逐篇确认归档；不生成虚拟文档ID。
      </p>
      <input
        type="file"
        accept=".zip"
        aria-label="导入Zotero ZIP"
        (change)="importZotero($event)"
      />
    </details>
    @if (error) {
      <p role="alert">{{ error }}</p>
    }
    @if (message) {
      <p role="status">{{ message }}</p>
    }
    <nav class="controls">
      <label
        >筛选标题<input aria-label="筛选候选标题" [(ngModel)]="filter" /></label
      ><label
        >日期<input
          aria-label="筛选候选日期"
          type="date"
          [(ngModel)]="date" /></label
      ><label
        >机构<input
          aria-label="筛选候选机构"
          [(ngModel)]="institution" /></label
      ><label
        ><input type="checkbox" [(ngModel)]="onlyToRead" />只看待读候选</label
      >
    </nav>
    @for (item of visible; track item.id) {
      <article [attr.id]="'candidate-' + item.id">
        <h3>{{ item.metadata['title'] }}</h3>
        <p class="small text-muted">
          {{ item.source }} {{ item.arxiv_id }} ·
          {{ item.metadata['authors'] }} ·
          {{
            item.metadata['published']?.slice(0, 10) || item.metadata['year']
          }}
          · {{ statuses[item.status] || item.status }}
        </p>
        <p class="abstract">{{ item.metadata['abstract'] }}</p>
        <div class="controls">
          <button (click)="toggle(item)">
            {{ item.to_read ? '移出候选待读' : '加入候选待读' }}
          </button>
          @if (item.document_id) {
            <a [routerLink]="['/documents', item.document_id, 'research']"
              >打开已归档文章</a
            >
          } @else if (item.status === 'archiving') {
            <button (click)="refresh(item)">核对真实归档结果</button>
          } @else if (item.status === 'candidate') {
            <button
              [disabled]="busy || (!item.has_pdf && !item.arxiv_id)"
              (click)="archive(item)"
            >
              归档至Paperless
            </button>
          } @else if (
            item.status === 'preparing' || item.status === 'uncertain'
          ) {
            <span
              >归档中断或提交结果不确定。请在Paperless文档与任务中核对，禁止自动重复上传。</span
            >
          } @else if (item.status === 'failed') {
            <span>归档未完成，请在Paperless任务中核对失败原因。</span>
          }
        </div>
        @if (!item.has_pdf && !item.arxiv_id) {
          <p class="small">缺少PDF附件，未创建文档。可重新上传带附件的ZIP。</p>
        }
      </article>
    } @empty {
      <p>暂无符合筛选的候选。可手动获取公开论文或导入Zotero ZIP。</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        background: var(--pngx-bg-alt);
        color: var(--bs-body-color);
        border: 1px solid var(--bs-border-color);
        padding: 1rem;
        min-width: 0;
      }
      header,
      .controls {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      header {
        justify-content: space-between;
        margin-bottom: 0.7rem;
      }
      h2 {
        font-size: 1.25rem;
        margin: 0;
      }
      h3 {
        font-size: 1rem;
      }
      button,
      input,
      a {
        font-size: 0.85rem;
      }
      button,
      input:not([type='checkbox']) {
        background: var(--pngx-bg-alt);
        color: var(--bs-body-color);
        border: 1px solid var(--bs-border-color);
        border-radius: 3px;
        padding: 0.3rem 0.5rem;
        max-width: 100%;
      }
      button:hover {
        border-color: var(--bs-primary);
        color: var(--bs-primary);
      }
      label {
        font-size: 0.8rem;
      }
      label input:not([type='checkbox']) {
        display: block;
      }
      a {
        color: var(--bs-primary);
      }
      article {
        border-top: 1px solid var(--bs-border-color);
        padding: 1rem 0;
      }
      .import-block {
        margin: 1rem 0;
      }
      .abstract {
        font-size: 0.9rem;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      @media (max-width: 767px) {
        :host {
          padding: 0.6rem;
        }
        .controls label {
          max-width: 100%;
        }
      }
      :host-context([data-bs-theme='dark']) a,
      :host-context([data-bs-theme='dark']) button.selected {
        color: var(--pngx-primary-lighten-30);
      }
    `,
  ],
})
export class ResearchDiscoveryComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient)
  private cdr = inject(ChangeDetectorRef)
  private destroy = new Subject<void>()
  private timer?: ReturnType<typeof setInterval>
  candidates: Candidate[] = []
  category = 'cs.AI'
  keyword = ''
  filter = ''
  date = ''
  institution = ''
  onlyToRead = false
  busy = false
  error = ''
  message = ''
  statuses: Record<string, string> = {
    candidate: '候选待确认',
    preparing: '归档准备中',
    archiving: 'Paperless处理中',
    archived: '已取得真实文档',
    failed: '归档失败',
    uncertain: '提交结果待人工核对',
  }
  get visible() {
    return this.candidates.filter(
      (item) =>
        item.metadata['title']
          .toLowerCase()
          .includes(this.filter.toLowerCase()) &&
        (!this.date ||
          (item.metadata['published'] || '').startsWith(this.date)) &&
        (!this.institution ||
          (item.metadata['institution'] || '')
            .toLowerCase()
            .includes(this.institution.toLowerCase())) &&
        (!this.onlyToRead || item.to_read)
    )
  }
  ngOnInit() {
    this.load()
    this.timer = setInterval(() => {
      this.candidates
        .filter((item) => item.status === 'archiving')
        .forEach((item) => this.refresh(item))
    }, 3000)
  }
  ngOnDestroy() {
    this.destroy.next()
    this.destroy.complete()
    clearInterval(this.timer)
  }
  load() {
    this.http
      .get<{ results: Candidate[] }>(
        environment.apiBaseUrl + 'research/collections/'
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: (r) => (this.candidates = r.results),
        error: () => (this.error = '候选列表暂不可用'),
      })
      .add(() => this.cdr.markForCheck())
  }
  fetch() {
    this.busy = true
    this.error = ''
    this.http
      .post<{ stored: number }>(environment.apiBaseUrl + 'research/arxiv/', {
        category: this.category,
        keyword: this.keyword,
      })
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: (r) => {
          this.message = `已保存${r.stored}篇公开候选，未调用AI`
          this.load()
        },
        error: (r) =>
          (this.error =
            r.error?.detail ?? '来源请求失败，没有生成候选成功记录'),
      })
      .add(() => {
        this.busy = false
        this.cdr.markForCheck()
      })
  }
  toggle(item: Candidate) {
    this.http
      .post(
        environment.apiBaseUrl + `research/collections/${item.id}/to_read/`,
        { to_read: !item.to_read }
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: () => this.load(),
        error: () => (this.error = '候选状态未保存'),
      })
      .add(() => this.cdr.markForCheck())
  }
  archive(item: Candidate) {
    this.busy = true
    this.error = ''
    this.http
      .post<Candidate>(
        environment.apiBaseUrl + `research/collections/${item.id}/archive/`,
        {}
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: () => {
          this.message = '已提交Paperless，等待真实消费结果；尚未视为完成'
          this.load()
        },
        error: (r) => (this.error = r.error?.detail ?? '归档未完成'),
      })
      .add(() => {
        this.busy = false
        this.cdr.markForCheck()
      })
  }
  refresh(item: Candidate) {
    this.http
      .post<Candidate>(
        environment.apiBaseUrl + `research/collections/${item.id}/refresh/`,
        {}
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: (r) => {
          const index = this.candidates.findIndex((c) => c.id === r.id)
          if (index >= 0) this.candidates[index] = r
        },
        error: (r) => (this.error = r.error?.detail ?? '无法核对归档状态'),
      })
      .add(() => this.cdr.markForCheck())
  }
  importZotero(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0]
    if (!file) return
    const body = new FormData()
    body.append('file', file)
    this.error = ''
    this.http
      .post<{ ids: string[] }>(
        environment.apiBaseUrl + 'research/zotero/',
        body
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: (r) => {
          this.message = `已预检${r.ids.length}条Zotero候选，尚未归档；请逐篇确认`
          input.value = ''
          this.load()
        },
        error: (r) =>
          (this.error = r.error?.detail ?? 'ZIP预检失败，未创建文档'),
      })
      .add(() => this.cdr.markForCheck())
  }
}
