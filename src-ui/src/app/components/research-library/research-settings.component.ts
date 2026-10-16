import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { FormsModule } from '@angular/forms'
import { environment } from 'src/environments/environment'
interface Preferences {
  model: string
  output_language: string
  analysis_template: string
  allowed_models: string[]
  ai_enabled: boolean
  parser: string
}
@Component({
  selector: 'pngx-research-settings',
  imports: [FormsModule],
  template: `
    <h2 class="h5">研究偏好</h2>
    <p>
      偏好仅属于当前账号。保存偏好不会调用模型；模型密钥仍由服务端私下配置，不在此页面传输或显示。
    </p>
    @if (settings) {
      <p>
        外部AI：{{
          settings.ai_enabled ? '已允许，仍需单篇授权' : '关闭'
        }}。配置名称不代表真实模型已经验证。
      </p>
      <label class="d-block mb-3"
        >指定模型<select
          class="form-select"
          aria-label="研究模型"
          [(ngModel)]="settings.model"
          [ngModelOptions]="{ standalone: true }"
        >
          @for (model of settings.allowed_models; track model) {
            <option [value]="model">{{ model }}</option>
          }
        </select></label
      ><label class="d-block mb-3"
        >输出语言<select
          class="form-select"
          aria-label="研究输出语言"
          [(ngModel)]="settings.output_language"
          [ngModelOptions]="{ standalone: true }"
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select></label
      ><label class="d-block mb-3"
        >自定义解读模板<textarea
          class="form-control"
          aria-label="解读模板"
          rows="9"
          maxlength="8000"
          [(ngModel)]="settings.analysis_template"
          [ngModelOptions]="{ standalone: true }"
          placeholder="留空采用研究问题、方法、证据、局限与复现要点模板"
        ></textarea></label
      ><button type="button" class="btn btn-sm btn-outline-primary" (click)="save()">
        保存研究偏好
      </button>
    }
    @if (message) {
      <p role="status">{{ message }}</p>
    }
    @if (error) {
      <p role="alert">{{ error }}</p>
    }
    <p class="mt-3 text-muted">
      数据导出与合并恢复位于每篇文章的“学术信息”面板。数据包不含Paperless原件和生产数据库，不替代服务器一致性备份。
    </p>
  `,
  styles: [
    `
      :host {
        display: block;
        color: var(--bs-body-color);
      }
      h2 {
        font-size: 1.1rem;
      }
      :host-context([data-bs-theme='dark']) a,
      :host-context([data-bs-theme='dark']) button.selected {
        color: var(--pngx-primary-lighten-30);
      }
    `,
  ],
})
export class ResearchSettingsComponent implements OnInit {
  private http = inject(HttpClient)
  private cdr = inject(ChangeDetectorRef)
  settings: Preferences | null = null
  message = ''
  error = ''
  ngOnInit() {
    this.http
      .get<Preferences>(environment.apiBaseUrl + 'research/settings/')
      .subscribe({
        next: (r) => (this.settings = r),
        error: () => (this.error = '研究设置暂不可用'),
      })
      .add(() => this.cdr.markForCheck())
  }
  save() {
    this.http
      .post<Preferences>(environment.apiBaseUrl + 'research/settings/', {
        model: this.settings.model,
        output_language: this.settings.output_language,
        analysis_template: this.settings.analysis_template,
      })
      .subscribe({
        next: (r) => {
          this.settings = r
          this.message = '研究偏好已保存，未发起模型调用'
          this.error = ''
        },
        error: (r) => (this.error = r.error?.detail ?? '保存失败'),
      })
      .add(() => this.cdr.markForCheck())
  }
}
