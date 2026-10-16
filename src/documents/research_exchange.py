"""Authenticated discovery/import orchestration into real Paperless documents."""
import json
import os
import re
import xml.etree.ElementTree as ET
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import requests
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from documents.models import PaperlessTask
from documents.research import permitted_document, research_key


class ResearchExchangeView(APIView):
    permission_classes = [IsAuthenticated]

    def internal(self, request, path, payload=None, raw=None, binary=False):
        base, secret = os.environ.get('PAPERLESS_RESEARCH_URL'), os.environ.get('PAPERLESS_RESEARCH_SECRET')
        if not base or not secret:
            raise URLError('Research unavailable')
        headers = {'X-Research-Secret': secret, 'X-Research-User': str(request.user.pk), 'Content-Type': 'application/json' if raw is None else 'application/octet-stream'}
        body = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        with urlopen(Request(base + path, data=body, headers=headers), timeout=30) as result:
            content = result.read(12 * 1024 * 1024 + 1)
            if len(content) > 12 * 1024 * 1024:
                raise ValueError()
            return content if binary else json.loads(content)

    def get(self, request, action='collections', identifier=None):
        return self.handle(request, action, identifier)

    def post(self, request, action='collections', identifier=None):
        return self.handle(request, action, identifier)

    def handle(self, request, action, identifier):
        if not request.user.is_active or not request.user.has_perm('documents.view_document'):
            raise PermissionDenied()
        if identifier and not re.fullmatch('[a-f0-9]{32}', identifier):
            return Response(status=404)
        try:
            if action == 'collections' and request.method == 'GET':
                response = Response(self.internal(request, '/collections'))
                response['Cache-Control'] = 'private, no-store'
                return response
            if action == 'zotero' and request.method == 'POST':
                if not request.user.has_perm('documents.add_document'):
                    raise PermissionDenied()
                upload = request.FILES.get('file')
                if upload is None or upload.size > 8 * 1024 * 1024:
                    return Response({'detail': '请选择不超过8MiB、包含RDF和PDF附件的ZIP。'}, status=400)
                return Response(self.internal(request, '/imports/zotero', raw=upload.read()), status=201)
            if action == 'arxiv' and request.method == 'POST':
                category = request.data.get('category', 'cs.AI')
                keyword = request.data.get('keyword', '')
                if not isinstance(category, str) or not re.fullmatch(r'[a-z-]+(?:\.[A-Za-z-]+)?', category) or not isinstance(keyword, str) or len(keyword) > 100:
                    return Response(status=400)
                query = 'cat:' + category + (' AND all:' + keyword if keyword else '')
                params = urlencode({'search_query': query, 'start': 0, 'max_results': 10, 'sortBy': 'submittedDate', 'sortOrder': 'descending'})
                with urlopen('https://export.arxiv.org/api/query?' + params, timeout=30) as external:
                    xml = external.read(2 * 1024 * 1024 + 1)
                if len(xml) > 2 * 1024 * 1024 or b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
                    raise ValueError()
                root = ET.fromstring(xml)
                atom = '{http://www.w3.org/2005/Atom}'
                arxiv = '{http://arxiv.org/schemas/atom}'
                items = []
                for entry in root.findall(atom + 'entry'):
                    identifier_text = (entry.findtext(atom + 'id') or '').split('/abs/')[-1]
                    if not self.valid_arxiv(identifier_text):
                        continue
                    items.append({'title': ' '.join((entry.findtext(atom + 'title') or '').split()), 'authors': ' and '.join(author.findtext(atom + 'name') or '' for author in entry.findall(atom + 'author')),
                                  'abstract': entry.findtext(atom + 'summary') or '', 'arxiv_id': identifier_text, 'year': (entry.findtext(atom + 'published') or '')[:4],
                                  'published': entry.findtext(atom + 'published') or '', 'journal': entry.findtext(arxiv + 'journal_ref') or '', 'doi': entry.findtext(arxiv + 'doi') or '',
                                  'category': category, 'institution': '; '.join(sorted({el.text.strip() for author in entry.findall(atom + 'author') for el in author.findall(arxiv + 'affiliation') if el.text})), 'metadata_source': 'arxiv; no AI enrichment'})
                result = self.internal(request, '/collections', {'items': items})
                return Response({'stored': len(result['ids']), 'ai_calls': 0})
            if identifier:
                path = '/collections/' + identifier
                candidate = self.internal(request, path)
                if action == 'to_read' and request.method == 'POST':
                    return Response(self.internal(request, path, {'to_read': bool(request.data.get('to_read'))}))
                if action == 'archive' and request.method == 'POST':
                    if not request.user.has_perm('documents.add_document') or not request.user.has_perm('documents.change_document'):
                        raise PermissionDenied()
                    if candidate['task_id'] or candidate['document_id'] or candidate['status'] != 'candidate':
                        return Response(candidate)
                    if not candidate['has_pdf'] and not self.valid_arxiv(candidate['arxiv_id']):
                        return Response({'detail': '缺少PDF附件或有效arXiv编号；未创建虚拟文档。'}, status=400)
                    self.internal(request, path + '/reserve', {})
                    if candidate['has_pdf']:
                        content = self.internal(request, path + '/source', binary=True)
                    elif self.valid_arxiv(candidate['arxiv_id']):
                        with urlopen('https://arxiv.org/pdf/' + candidate['arxiv_id'], timeout=45) as external:
                            content = external.read(10 * 1024 * 1024 + 1)
                    else:
                        return Response({'detail': '缺少PDF附件或有效arXiv编号；未创建虚拟文档。'}, status=400)
                    if len(content) > 10 * 1024 * 1024 or not content.startswith(b'%PDF-'):
                        self.internal(request, path, {'status': 'candidate'})
                        return Response({'detail': '来源未返回允许大小的真实PDF。'}, status=400)
                    headers = {name: request.headers[name] for name in ('Authorization', 'Cookie', 'X-CSRFToken') if request.headers.get(name)}
                    self.internal(request, path, {'status': 'uncertain'})
                    response = requests.post('http://127.0.0.1:8000/api/documents/post_document/', headers=headers,
                                             files={'document': ('research-import.pdf', content, 'application/pdf')},
                                             data={'title': candidate['metadata']['title'], 'owner': request.user.pk}, timeout=30)
                    if response.status_code != 200 or not isinstance(response.json(), str):
                        return Response({'detail': 'Paperless拒绝归档，请检查新增文档权限。'}, status=400)
                    task_id = response.json()
                    return Response(self.internal(request, path, {'status': 'archiving', 'task_id': task_id}), status=202)
                if action == 'refresh' and request.method == 'POST':
                    if not candidate['task_id']:
                        return Response(candidate)
                    task = PaperlessTask.objects.filter(task_id=candidate['task_id']).first()
                    if task is None or not task.is_complete:
                        return Response(candidate)
                    ids = task.related_document_ids
                    if not ids:
                        return Response(self.internal(request, path, {'status': 'failed'}))
                    document = permitted_document(request.user, ids[0], change=True)
                    document_path = '/papers/' + research_key(document)
                    self.internal(request, document_path, {'title': document.title, 'document_id': document.pk, 'instance': os.environ['PAPERLESS_RESEARCH_INSTANCE']})
                    state = self.internal(request, document_path)
                    additions = {name: value for name, value in candidate['metadata'].items() if name in {'title', 'authors', 'year', 'journal', 'doi', 'arxiv_id', 'abstract', 'keywords'} and not state['bibliography'].get(name)}
                    if additions:
                        self.internal(request, document_path + '/bibliography', additions)
                    if candidate['to_read']:
                        personal = self.internal(request, document_path)['personal']
                        if personal['list_status'] == 'none':
                            self.internal(request, document_path + '/personal', {'list_status': 'inbox'})
                    return Response(self.internal(request, path, {'status': 'archived', 'document_id': document.pk}))
            return Response(status=405)
        except HTTPError as error:
            return Response({'detail': '记录不存在、已提交或来源服务不可用，请核对候选状态。'}, status=error.code if error.code in (400, 404, 409) else 503)
        except (URLError, TimeoutError, ValueError, KeyError, ET.ParseError, requests.RequestException):
            return Response({'detail': '来源请求或归档未完成；不会自动创建假文档或调用模型，请核对后重试。'}, status=503)

    @staticmethod
    def valid_arxiv(value):
        return isinstance(value, str) and re.fullmatch(r'(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?', value) is not None
