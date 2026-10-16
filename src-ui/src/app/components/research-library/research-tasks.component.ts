import {
  Component,
  inject,
  ChangeDetectorRef,
  OnInit,
  OnDestroy,
} from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { RouterLink } from '@angular/router'
import { environment } from 'src/environments/environment'
import { Subject, takeUntil } from 'rxjs'
interface Task {
  id: string
  document_id: number
  title: string
  kind: string
  status: string
  stage: string
  attempt: number
  error_detail: string
}
@Component({
  selector: 'pngx-research-tasks',
  imports: [RouterLink],
  template: `
    <h2 class="h4">研究任务中心</h2>
    <p>
      仅显示当前有权访问的文档任务。失败与中断不会自动重复付费调用；重试须回到对应文章明确授权。
    </p>
    <button class="btn btn-sm btn-outline-primary mb-3" (click)="load()">
      刷新任务
    </button>
    @if (error) {
      <p role="alert">{{ error }}</p>
    }
    @for (task of tasks; track task.id) {
      <article class="border-bottom py-3">
        <a [routerLink]="['/documents', task.document_id, 'research']">{{
          task.title
        }}</a>
        <p class="mb-1">
          {{ kinds[task.kind] || task.kind }} ·
          {{ statuses[task.status] || task.status }} · 尝试{{ task.attempt }}次
        </p>
        @if (task.error_detail) {
          <p>{{ task.error_detail }}</p>
        }
        @if (['queued', 'running', 'cancel_requested'].includes(task.status)) {
          <button
            class="btn btn-sm btn-outline-secondary"
            (click)="cancel(task)"
            [disabled]="task.status === 'cancel_requested'"
          >
            {{
              task.status === 'cancel_requested' ? '等待取消确认' : '取消任务'
            }}
          </button>
        }
      </article>
    } @empty {
      <p>暂无可见研究任务。</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        background: var(--pngx-bg-alt);
        color: var(--bs-body-color);
        padding: 1rem;
        border: 1px solid var(--bs-border-color);
      }
      a {
        color: var(--bs-primary);
      }
      h2 {
        font-size: 1.25rem;
      }
      :host-context([data-bs-theme='dark']) a,
      :host-context([data-bs-theme='dark']) button.selected {
        color: var(--pngx-primary-lighten-30);
      }
    `,
  ],
})
export class ResearchTasksComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient)
  private cdr = inject(ChangeDetectorRef)
  private destroy = new Subject<void>()
  private timer?: ReturnType<typeof setInterval>
  tasks: Task[] = []
  error = ''
  kinds: Record<string, string> = {
    translation: '翻译',
    analysis: '解读',
    manual_import: '人工导入',
  }
  statuses: Record<string, string> = {
    queued: '等待执行',
    running: '处理中',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    cancel_requested: '取消中',
    cancelled: '已取消',
  }
  ngOnInit() {
    this.load()
    this.timer = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        this.tasks.some((t) =>
          ['queued', 'running', 'cancel_requested'].includes(t.status)
        )
      )
        this.load()
    }, 3000)
  }
  ngOnDestroy() {
    this.destroy.next()
    this.destroy.complete()
    clearInterval(this.timer)
  }
  load(offset = 0) {
    if (!offset) this.tasks = []
    this.http
      .get<{ results: Task[]; next_offset: number | null }>(
        environment.apiBaseUrl + `research/tasks/?offset=${offset}`
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: (r) => {
          this.tasks.push(...r.results)
          if (r.next_offset !== null) this.load(r.next_offset)
        },
        error: () => (this.error = '任务暂不可用，请刷新'),
      })
      .add(() => this.cdr.markForCheck())
  }
  cancel(task: Task) {
    this.http
      .post(
        environment.apiBaseUrl +
          `research/documents/${task.document_id}/tasks/${task.id}/cancel/`,
        {}
      )
      .pipe(takeUntil(this.destroy))
      .subscribe({
        next: () => this.load(),
        error: (r) =>
          (this.error = r.error?.detail ?? '取消请求未成功，请检查修改权限'),
      })
      .add(() => this.cdr.markForCheck())
  }
}
