import {
  Component,
  EventEmitter,
  Output,
  inject,
  afterRenderEffect,
  ElementRef,
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { AnnotationSession } from './annotation-session.service'
import { AnnotationRecord } from './annotation-contract'

@Component({
  selector: 'pngx-annotation-panel',
  imports: [FormsModule],
  template: `
    <p class="small" role="status">{{ session.status() }}</p>
    @if (session.otherVersions()) {
      <p class="small">其他PDF版本有批注，已保留；不会套用到当前版本。</p>
    }
    @if (session.unresolved()) {
      <button
        type="button"
        class="btn btn-sm btn-outline-primary"
        (click)="session.retry()"
      >
        重试保存
      </button>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        (click)="session.downloadDrafts()"
      >
        下载恢复草稿
      </button>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        (click)="session.archiveDrafts()"
      >
        保留服务端版本，归档草稿
      </button>
    }
    @if (session.available()) {
      @if (!session.capabilities().annotations) {
        <p class="small">此PDF当前仅支持只读；批注工具未启用。</p>
      }
      <div class="exports">
        <button
          type="button"
          class="btn btn-sm btn-outline-primary"
          [disabled]="
            session.unresolved() > 0 || !session.capabilities().export
          "
          (click)="session.exportPdf()"
        >
          导出带批注PDF
        </button>
        <a
          class="btn btn-sm btn-outline-secondary"
          [href]="session.summaryUrl()"
          download
          >导出批注摘要</a
        >
        <a
          class="btn btn-sm btn-outline-secondary"
          [href]="session.jsonUrl()"
          download
          >导出批注JSON</a
        >
      </div>
    }
    @for (item of session.records(); track item.id) {
      <article
        [attr.data-annotation-id]="item.id"
        [class.selected]="session.selected() === item.id"
      >
        <button
          type="button"
          class="location"
          (click)="session.port?.focus(item)"
        >
          第{{ item.page }}页 · {{ labels[item.type] }}
        </button>
        @if (item.quote) {
          <blockquote>{{ item.quote }}</blockquote>
        }
        <label
          >标记颜色
          <input
            type="color"
            [attr.aria-label]="'批注颜色 ' + item.id"
            [ngModel]="item.color"
            [disabled]="!session.capabilities().annotations"
            (ngModelChange)="session.port?.color(item, $event)"
        /></label>
        <label
          >批注评论<textarea
            class="form-control"
            rows="3"
            [attr.aria-label]="'批注评论 ' + item.id"
            [ngModel]="item.comment"
            [disabled]="!session.capabilities().annotations"
            (ngModelChange)="session.commentDraft(item, $event)"
          ></textarea>
        </label>
        <div class="actions">
          <button
            type="button"
            class="btn btn-sm btn-outline-primary"
            (click)="session.flushComments()"
            [disabled]="!session.capabilities().annotations"
          >
            保存评论
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            (click)="appendNote(item)"
          >
            摘录插入笔记
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-danger"
            (click)="session.port?.remove(item)"
            [disabled]="!session.capabilities().annotations"
          >
            删除
          </button>
        </div>
      </article>
    } @empty {
      <p class="small">
        本PDF版本暂无私人批注。可选择多行文字后点击高亮、下划线或评论，也可区域标记与手绘。
      </p>
    }
    <p class="small text-muted">
      位置批注仅当前账号可见。文章整体研究记录仍保存在“个人笔记”。
    </p>
  `,
  styles:
    ':host{display:block;min-width:0}article{border-bottom:1px solid var(--bs-border-color);padding:.6rem 0}article.selected{border-left:3px solid var(--bs-primary);padding-left:.5rem}.location{background:transparent;border:0;color:var(--bs-primary);padding:0}blockquote{white-space:pre-wrap;margin:.5rem 0;font-size:.85rem;border-left:2px solid var(--bs-border-color);padding-left:.5rem}label{width:100%;font-size:.85rem}.actions,.exports{display:flex;flex-wrap:wrap;gap:.3rem;margin:.4rem 0}button,a{font-size:.75rem}',
})
export class AnnotationPanelComponent {
  session = inject(AnnotationSession)
  private element: ElementRef<HTMLElement> = inject(ElementRef)
  constructor() {
    afterRenderEffect(() => {
      const id = this.session.selected()
      if (!id) return
      const entry = this.element.nativeElement.querySelector<HTMLElement>(
        `article[data-annotation-id="${id}"]`
      )
      if (entry?.offsetParent)
        entry.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  labels = {
    highlight: '高亮',
    underline: '下划线',
    rectangle: '区域',
    ink: '手绘',
    text: '评论',
  }
  @Output() append = new EventEmitter<string>()
  appendNote(item: AnnotationRecord) {
    this.session.flushComments()
    this.append.emit(
      [item.quote, item.comment, `（第${item.page}页）`]
        .filter(Boolean)
        .join('\n')
    )
  }
}
