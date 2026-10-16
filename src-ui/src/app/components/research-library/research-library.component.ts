import { HttpClient } from '@angular/common/http'
import {
  ChangeDetectorRef,
  Component,
  inject,
  OnInit,
  OnDestroy,
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { Subject, takeUntil } from 'rxjs'
import { environment } from 'src/environments/environment'
import { SettingsService } from 'src/app/services/settings.service'
interface Paper {
  document_id: number
  title: string
  list_status: string
  starred: boolean
  last_opened: string
  reading_days: { day: string; seconds: number; imported_seconds?: number }[]
}
@Component({
  selector: 'pngx-research-library',
  imports: [RouterLink, FormsModule],
  template: ` <div class="reading-center">
    <header>
      <h2>我的阅读列表</h2>
      <a class="reader-link" routerLink="/documents">文档库</a
      ><button type="button" (click)="load()">刷新</button>
    </header>
    <a routerLink="/research/discovery">候选待读与Zotero导入</a>
    <p class="text-muted small">
      加入列表仅保存个人关联，不复制原文、不自动调用AI。仅显示当前仍有权限的文章。
    </p>
    @if (error) {
      <p role="alert">{{ error }}</p>
    }
    <nav aria-label="阅读列表筛选">
      @for (tab of tabs; track tab.value) {
        <button
          type="button"
          [class.selected]="filter === tab.value"
          (click)="filter = tab.value; storeFilter()"
        >
          {{ tab.label }}
        </button>
      }
      <input
        aria-label="搜索阅读列表"
        placeholder="搜索文章"
        [(ngModel)]="query"
        (ngModelChange)="storeFilter()"
      />
    </nav>
    <div class="calendar">
      <div class="calendar-heading">
        <span>阅读日历 · {{ totalSeconds }} 秒</span
        ><select
          aria-label="日历年份"
          [(ngModel)]="year"
          (ngModelChange)="makeDays()"
        >
          <option [value]="currentYear">{{ currentYear }}</option>
          <option [value]="currentYear - 1">{{ currentYear - 1 }}</option>
        </select>
        @if (selectedDate) {
          <button (click)="selectedDate = ''; storeFilter()">
            清除 {{ selectedDate }}
          </button>
        }
      </div>
      <div class="calendar-scroll">
        <div class="heatmap" aria-label="真实阅读日历">
          @for (day of days; track day) {
            <button
              [title]="day + ' · ' + (daily[day] || 0) + ' 秒'"
              [attr.aria-label]="day + ' 阅读 ' + (daily[day] || 0) + ' 秒'"
              [class.active]="daily[day] > 0"
              [style.opacity]="
                daily[day] ? 0.4 + Math.min(daily[day] / 300, 0.6) : 1
              "
              (click)="selectedDate = day; storeFilter()"
            ></button>
          }
        </div>
      </div>
      <p class="small text-muted">
        统计页面可见且有焦点的阅读记录；不会把打开时间或演示数据当阅读时长。{{
          importedSeconds
            ? '其中 ' + importedSeconds + ' 秒来自个人存档导入（未重新验证）'
            : ''
        }}
      </p>
    </div>
    @if (loading) {
      <p role="status">正在加载阅读记录…</p>
    }
    @for (paper of filtered; track paper.document_id) {
      <article>
        <div class="paper-title">
          <a
            [routerLink]="['/documents', paper.document_id, 'research']"
            [queryParams]="{ from: router.url }"
            (click)="rememberScroll()"
            >{{ paper.title }}</a
          ><span>{{ paper.starred ? '★' : '' }}</span>
        </div>
        <div class="paper-controls">
          <select
            [attr.aria-label]="paper.title + ' 阅读状态'"
            [(ngModel)]="paper.list_status"
            (ngModelChange)="save(paper)"
          >
            <option value="inbox">待读</option>
            <option value="reading">正在读</option>
            <option value="completed">已读</option>
            <option value="none">未加入</option></select
          ><button
            type="button"
            [attr.aria-label]="paper.title + ' 星标'"
            (click)="paper.starred = !paper.starred; save(paper)"
          >
            {{ paper.starred ? '取消星标' : '星标' }}</button
          ><button
            type="button"
            (click)="
              paper.list_status = 'none'; paper.starred = false; save(paper)
            "
          >
            移出列表
          </button>
          @if (paper.last_opened) {
            <span class="small text-muted"
              >最近阅读 {{ paper.last_opened.slice(0, 10) }}</span
            >
          }
        </div>
      </article>
    } @empty {
      <p class="empty">暂无符合筛选的文章。可在文档详情中加入待读。</p>
    }
  </div>`,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .reading-center {
        background: var(--pngx-bg-alt);
        color: var(--bs-body-color);
        border: 1px solid var(--bs-border-color);
        padding: 1rem;
      }
      header,
      nav,
      .calendar-heading,
      .paper-controls {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
      }
      h2 {
        font-size: 1.3rem;
        flex: 1;
        margin: 0;
      }
      header {
        margin-bottom: 0.75rem;
      }
      button,
      .reader-link,
      select,
      input {
        background: var(--pngx-bg-alt);
        color: var(--bs-body-color);
        border: 1px solid var(--bs-border-color);
        border-radius: 3px;
        padding: 0.3rem 0.6rem;
        font-size: 0.85rem;
      }
      button.selected {
        border-color: var(--bs-primary);
        color: var(--bs-primary);
        background: color-mix(
          in srgb,
          var(--bs-primary) 8%,
          var(--pngx-bg-alt)
        );
      }
      nav input {
        flex: 1;
        min-width: 100px;
      }
      article {
        padding: 1rem 0;
        border-bottom: 1px solid var(--bs-border-color);
      }
      .paper-title {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      }
      .paper-title a {
        color: var(--bs-primary);
        font-weight: 600;
      }
      .calendar {
        border-bottom: 1px solid var(--bs-border-color);
        padding: 0.8rem 0;
      }
      .calendar-scroll {
        max-width: 100%;
        overflow: auto;
      }
      .heatmap {
        display: grid;
        grid-template-rows: repeat(7, 11px);
        grid-auto-flow: column;
        grid-auto-columns: 11px;
        gap: 3px;
        margin: 0.7rem 0;
        width: max-content;
      }
      .heatmap button {
        background: var(--pngx-bg-darker);
        border: 1px solid var(--bs-border-color);
        border-radius: 1px;
        padding: 0;
        min-width: 0;
      }
      .heatmap button.active {
        background: var(--bs-primary);
        border-color: var(--bs-primary);
      }
      .empty {
        padding: 2rem 0;
        color: var(--bs-secondary-color);
      }
      @media (max-width: 767px) {
        .reading-center {
          padding: 0.6rem;
        }
        .paper-title {
          overflow-wrap: anywhere;
        }
        .paper-controls {
          gap: 0.3rem;
        }
        .paper-controls .small {
          width: 100%;
        }
      }
      :host-context([data-bs-theme='dark']) a,
      :host-context([data-bs-theme='dark']) button.selected {
        color: var(--pngx-primary-lighten-30);
      }
    `,
  ],
})
export class ResearchLibraryComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient)
  private cdr = inject(ChangeDetectorRef)
  router = inject(Router)
  private route = inject(ActivatedRoute)
  private settings = inject(SettingsService)
  private destroy = new Subject<void>()
  papers: Paper[] = []
  filter = 'all'
  query = ''
  selectedDate = ''
  loading = false
  error = ''
  currentYear = new Date().getFullYear()
  year = this.currentYear
  days: string[] = []
  daily: Record<string, number> = {}
  totalSeconds = 0
  importedSeconds = 0
  Math = Math
  tabs = [
    { value: 'all', label: '全部' },
    { value: 'inbox', label: '待读' },
    { value: 'reading', label: '正在读' },
    { value: 'completed', label: '已读' },
    { value: 'starred', label: '星标' },
    { value: 'recent', label: '最近阅读' },
  ]
  private get positionKey() {
    return `research-list-position:${this.settings.currentUser()?.id}`
  }
  get filtered() {
    return this.papers
      .filter(
        (p) =>
          (this.filter === 'recent'
            ? !!p.last_opened
            : this.filter === 'starred'
              ? p.starred
              : this.filter === 'all'
                ? p.list_status !== 'none' || p.starred
                : p.list_status === this.filter) &&
          p.title.toLowerCase().includes(this.query.toLowerCase()) &&
          (!this.selectedDate ||
            p.reading_days.some(
              (d) => d.day === this.selectedDate && d.seconds > 0
            ))
      )
      .sort(
        (a, b) =>
          b.last_opened.localeCompare(a.last_opened) ||
          a.title.localeCompare(b.title)
      )
  }
  ngOnInit() {
    const q = this.route.snapshot.queryParamMap
    this.filter = this.tabs.some((t) => t.value === q.get('filter'))
      ? q.get('filter')
      : 'all'
    this.query = q.get('q') || ''
    this.selectedDate = q.get('day') || ''
    this.makeDays()
    this.load()
  }
  ngOnDestroy() {
    this.destroy.next()
    this.destroy.complete()
  }
  makeDays() {
    const start = new Date(Number(this.year), 0, 1)
    start.setDate(start.getDate() - start.getDay())
    this.days = []
    for (
      let date = new Date(start);
      date.getFullYear() <= Number(this.year);
      date.setDate(date.getDate() + 1)
    ) {
      this.days.push(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      )
    }
    this.cdr.markForCheck()
  }
  storeFilter() {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        filter: this.filter,
        q: this.query || null,
        day: this.selectedDate || null,
      },
      replaceUrl: true,
    })
  }
  rememberScroll() {
    sessionStorage.setItem(
      this.positionKey,
      JSON.stringify({
        window: window.scrollY,
        main: document.querySelector('main')?.scrollTop || 0,
      })
    )
  }
  load(offset = 0) {
    if (offset === 0) {
      this.papers = []
      this.daily = {}
      this.totalSeconds = 0
      this.importedSeconds = 0
    }
    this.loading = true
    this.error = ''
    this.http
      .get<{ results: Paper[]; next_offset: number | null }>(
        environment.apiBaseUrl + `research/library/?offset=${offset}`
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: (page) => {
          this.papers.push(...page.results)
          page.results.forEach((p) =>
            p.reading_days.forEach((d) => {
              this.daily[d.day] = (this.daily[d.day] || 0) + d.seconds
              this.totalSeconds += d.seconds
              this.importedSeconds += d.imported_seconds || 0
            })
          )
          if (page.next_offset !== null) {
            this.load(page.next_offset)
            return
          }
          this.loading = false
          setTimeout(() => {
            try {
              const saved = JSON.parse(
                sessionStorage.getItem(this.positionKey) || '{}'
              )
              window.scrollTo(0, saved.window || 0)
              const main = document.querySelector('main')
              if (main) main.scrollTop = saved.main || 0
            } catch {}
          }, 0)
        },
        error: () => {
          this.error = '阅读列表暂不可用，请重试'
          this.loading = false
        },
      })
      .add(() => this.cdr.markForCheck())
  }
  save(paper: Paper) {
    this.http
      .post(
        environment.apiBaseUrl +
          `research/documents/${paper.document_id}/personal/`,
        { list_status: paper.list_status, starred: paper.starred }
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        error: () => {
          this.error = '保存失败，已重新读取当前状态'
          this.load()
        },
      })
      .add(() => this.cdr.markForCheck())
  }
}
