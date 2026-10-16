import {
  Component,
  Input,
  OnChanges,
  inject,
  ChangeDetectorRef,
} from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { environment } from 'src/environments/environment'

@Component({
  selector: 'pngx-research-membership',
  template: `<button
      type="button"
      class="btn btn-sm btn-outline-primary"
      [disabled]="busy"
      (click)="toggle()"
    >
      {{ listed ? '移出阅读列表' : '加入待读' }}
    </button>
    @if (message) {
      <span class="small ms-2" role="status">{{ message }}</span>
    }`,
})
export class ResearchMembershipComponent implements OnChanges {
  @Input({ required: true }) documentId!: number
  private http = inject(HttpClient)
  private cdr = inject(ChangeDetectorRef)
  listed = false
  busy = false
  message = ''
  private get url() {
    return `${environment.apiBaseUrl}research/documents/${this.documentId}/`
  }
  ngOnChanges() {
    const id = this.documentId
    this.listed = false
    this.message = ''
    this.http
      .get<{ personal: { list_status: string; starred: boolean } }>(this.url)
      .subscribe({
        next: (result) => {
          if (id === this.documentId)
            this.listed =
              result.personal.list_status !== 'none' ||
              !!result.personal.starred
        },
        error: () => {
          this.message = '阅读列表暂不可用'
        },
      })
      .add(() => this.cdr.markForCheck())
  }
  toggle() {
    const id = this.documentId,
      url = this.url,
      listed = this.listed
    this.busy = true
    this.http.post(url, {}).subscribe({
      next: () => {
        this.http
          .post(url + 'personal/', {
            list_status: listed ? 'none' : 'inbox',
            starred: false,
          })
          .subscribe({
            next: () => {
              if (id === this.documentId) {
                this.listed = !listed
                this.message = listed
                  ? '已移出，原文和笔记保留'
                  : '已加入待读，未创建AI任务'
              }
            },
            error: () => (this.message = '保存失败，请重试'),
          })
          .add(() => {
            this.busy = false
            this.cdr.markForCheck()
          })
      },
      error: () => {
        this.busy = false
        this.message = '研究服务暂不可用'
        this.cdr.markForCheck()
      },
    })
  }
}
