import { defineMessages } from '../../i18n';

export const i18n = defineMessages({
  panelTitle: {
    id: 'liveBrowser.panelTitle',
    defaultMessage: 'Live Browser',
  },
  iconTooltip: {
    id: 'liveBrowser.iconTooltip',
    defaultMessage: 'Show / hide Live Browser panel',
  },
  urlPlaceholder: {
    id: 'liveBrowser.urlPlaceholder',
    defaultMessage: 'https://example.com',
  },
  open: {
    id: 'liveBrowser.open',
    defaultMessage: 'Open',
  },
  back: {
    id: 'liveBrowser.back',
    defaultMessage: 'Back',
  },
  forward: {
    id: 'liveBrowser.forward',
    defaultMessage: 'Forward',
  },
  reload: {
    id: 'liveBrowser.reload',
    defaultMessage: 'Reload',
  },
  newArea: {
    id: 'liveBrowser.newArea',
    defaultMessage: 'New area',
  },
  selectHint: {
    id: 'liveBrowser.selectHint',
    defaultMessage: 'Drag a rectangle over the page to select an area',
  },
  areaName: {
    id: 'liveBrowser.areaName',
    defaultMessage: 'Name',
  },
  areaDescription: {
    id: 'liveBrowser.areaDescription',
    defaultMessage: 'Task / description',
  },
  status: {
    id: 'liveBrowser.status',
    defaultMessage: 'Status',
  },
  technicalData: {
    id: 'liveBrowser.technicalData',
    defaultMessage: 'Technical data',
  },
  includeInNext: {
    id: 'liveBrowser.includeInNext',
    defaultMessage: 'Include in next message',
  },
  removeArea: {
    id: 'liveBrowser.removeArea',
    defaultMessage: 'Remove area',
  },
  markFixed: {
    id: 'liveBrowser.markFixed',
    defaultMessage: 'Mark fixed',
  },
  markVerified: {
    id: 'liveBrowser.markVerified',
    defaultMessage: 'Mark verified',
  },
  markUnresolved: {
    id: 'liveBrowser.markUnresolved',
    defaultMessage: 'Mark unresolved',
  },
  auto: {
    id: 'liveBrowser.auto',
    defaultMessage: 'Auto',
  },
  zoom: {
    id: 'liveBrowser.zoom',
    defaultMessage: 'Zoom',
  },
  fit: {
    id: 'liveBrowser.fit',
    defaultMessage: 'Fit',
  },
  modeSplit: {
    id: 'liveBrowser.modeSplit',
    defaultMessage: 'Split',
  },
  modeExpanded: {
    id: 'liveBrowser.modeExpanded',
    defaultMessage: 'Expanded',
  },
  modeChatOnly: {
    id: 'liveBrowser.modeChatOnly',
    defaultMessage: 'Chat only',
  },
  closePanel: {
    id: 'liveBrowser.closePanel',
    defaultMessage: 'Hide panel (browser keeps running)',
  },
  connecting: {
    id: 'liveBrowser.connecting',
    defaultMessage: 'Connecting to the browser runtime…',
  },
  runtimeError: {
    id: 'liveBrowser.runtimeError',
    defaultMessage: 'Browser runtime error: {error}',
  },
  retry: {
    id: 'liveBrowser.retry',
    defaultMessage: 'Retry',
  },
  noPage: {
    id: 'liveBrowser.noPage',
    defaultMessage: 'No page open yet — enter a URL above.',
  },
  agentBusy: {
    id: 'liveBrowser.agentBusy',
    defaultMessage: 'Agent is working',
  },
  ownershipUser: {
    id: 'liveBrowser.ownershipUser',
    defaultMessage: 'Your control',
  },
  ownershipAgent: {
    id: 'liveBrowser.ownershipAgent',
    defaultMessage: 'Agent control',
  },
  staleBinding: {
    id: 'liveBrowser.staleBinding',
    defaultMessage: 'Binding is stale — original selection data preserved',
  },
  regionAdded: {
    id: 'liveBrowser.regionAdded',
    defaultMessage: 'Area saved',
  },
  groundFailed: {
    id: 'liveBrowser.groundFailed',
    defaultMessage: 'Could not save the selection: {error}',
  },
  sendingContext: {
    id: 'liveBrowser.sendingContext',
    defaultMessage: 'Next message will include: {names}',
  },
  visionOffNote: {
    id: 'liveBrowser.visionOffNote',
    defaultMessage:
      'Vision off: the model receives the text context (DOM, geometry, CSS, URL), not the image.',
  },
  visionOnNote: {
    id: 'liveBrowser.visionOnNote',
    defaultMessage: 'Vision on: the model also receives the region screenshot.',
  },
  captureFailed: {
    id: 'liveBrowser.captureFailed',
    defaultMessage: 'Could not capture the region: {error}',
  },
  selectAll: {
    id: 'liveBrowser.selectAll',
    defaultMessage: 'All',
  },
  deselectAll: {
    id: 'liveBrowser.deselectAll',
    defaultMessage: 'None',
  },
  removeRegion: {
    id: 'liveBrowser.removeRegion',
    defaultMessage: 'Remove selection',
  },
  liveCheck: {
    id: 'liveBrowser.liveCheck',
    defaultMessage: 'Re-check binding',
  },
  closeBrowser: {
    id: 'liveBrowser.closeBrowser',
    defaultMessage: 'Close browser session',
  },
  sessionClosed: {
    id: 'liveBrowser.sessionClosed',
    defaultMessage: 'Browser session closed',
  },
  pageZoom: {
    id: 'liveBrowser.pageZoom',
    defaultMessage: 'Page zoom',
  },
  previewScale: {
    id: 'liveBrowser.previewScale',
    defaultMessage: 'Preview scale',
  },
  agentAction: {
    id: 'liveBrowser.agentAction',
    defaultMessage: 'Agent action: {detail}',
  },
  urlBlocked: {
    id: 'liveBrowser.urlBlocked',
    defaultMessage: 'URL not allowed: {error}',
  },
  regionsCount: {
    id: 'liveBrowser.regionsCount',
    defaultMessage: '{count, plural, =0 {no selections} one {# selection} other {# selections}}',
  },
  anchorsCount: {
    id: 'liveBrowser.anchorsCount',
    defaultMessage: '{count, plural, =0 {no DOM anchors} one {# DOM anchor} other {# DOM anchors}}',
  },
  viewportLabel: {
    id: 'liveBrowser.viewportLabel',
    defaultMessage: 'Viewport',
  },
  scrollLabel: {
    id: 'liveBrowser.scrollLabel',
    defaultMessage: 'Scroll',
  },
  dprLabel: {
    id: 'liveBrowser.dprLabel',
    defaultMessage: 'DPR',
  },
  confidenceLabel: {
    id: 'liveBrowser.confidenceLabel',
    defaultMessage: 'Confidence',
  },
  notInElectron: {
    id: 'liveBrowser.notInElectron',
    defaultMessage: 'Live Browser is available in the desktop app.',
  },
  diagnosticsLabel: {
    id: 'liveBrowser.diagnosticsLabel',
    defaultMessage: 'Diagnostics',
  },
  historyLabel: {
    id: 'liveBrowser.historyLabel',
    defaultMessage: 'History',
  },
  lastCheckLabel: {
    id: 'liveBrowser.lastCheckLabel',
    defaultMessage: 'Last check',
  },
  urlLabel: {
    id: 'liveBrowser.urlLabel',
    defaultMessage: 'URL',
  },
  createdLabel: {
    id: 'liveBrowser.createdLabel',
    defaultMessage: 'Created',
  },
  pendingNote: {
    id: 'liveBrowser.pendingNote',
    defaultMessage:
      '{names} will be included in the next message to the agent',
  },
});
