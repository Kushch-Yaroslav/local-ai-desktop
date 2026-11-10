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
  defaultAreaName: {
    id: 'liveBrowser.defaultAreaName',
    defaultMessage: 'Area {number}',
  },
  potentialAreaName: {
    id: 'liveBrowser.potentialAreaName',
    defaultMessage: 'Potential issue',
  },
  selectArea: {
    id: 'liveBrowser.selectArea',
    defaultMessage: 'Select area',
  },
  openPageToSelect: {
    id: 'liveBrowser.openPageToSelect',
    defaultMessage: 'Open a page to select',
  },
  emptyAreas: {
    id: 'liveBrowser.emptyAreas',
    defaultMessage: 'No areas yet. Select the part of the page you want the AI to inspect.',
  },
  noMatchingAreas: {
    id: 'liveBrowser.noMatchingAreas',
    defaultMessage: 'No matching areas.',
  },
  showOnPage: {
    id: 'liveBrowser.showOnPage',
    defaultMessage: 'Show on page',
  },
  hideRegionMarkers: {
    id: 'liveBrowser.hideRegionMarkers',
    defaultMessage: 'Hide region markers',
  },
  showRegionMarkers: {
    id: 'liveBrowser.showRegionMarkers',
    defaultMessage: 'Show region markers',
  },
  areaDescriptionLabel: {
    id: 'liveBrowser.areaDescriptionLabel',
    defaultMessage: 'Problem description / what should be fixed',
  },
  areaDescriptionHint: {
    id: 'liveBrowser.areaDescriptionHint',
    defaultMessage: 'This description is sent to AI with the selected area.',
  },
  areaDescriptionExample: {
    id: 'liveBrowser.areaDescriptionExample',
    defaultMessage: 'For example: the button needs more padding.',
  },
  attachmentHasDescription: {
    id: 'liveBrowser.attachmentHasDescription',
    defaultMessage: 'Has description',
  },
  attachmentRegionsCount: {
    id: 'liveBrowser.attachmentRegionsCount',
    defaultMessage: '{count, plural, =0 {no regions} one {# region} other {# regions}}',
  },
  visionLabel: {
    id: 'liveBrowser.visionLabel',
    defaultMessage: 'Vision',
  },
  visionOn: {
    id: 'liveBrowser.visionOn',
    defaultMessage: 'On',
  },
  visionOff: {
    id: 'liveBrowser.visionOff',
    defaultMessage: 'Off',
  },
  projectLinked: {
    id: 'liveBrowser.projectLinked',
    defaultMessage: 'Project linked to this chat',
  },
  noProjectBound: {
    id: 'liveBrowser.noProjectBound',
    defaultMessage: 'No project linked to this chat',
  },
  removeAttachment: {
    id: 'liveBrowser.removeAttachment',
    defaultMessage: 'Remove {name}',
  },
  deleteAllAreas: {
    id: 'liveBrowser.deleteAllAreas',
    defaultMessage: 'Delete all areas',
  },
  deleteAllAreasConfirm: {
    id: 'liveBrowser.deleteAllAreasConfirm',
    defaultMessage: 'Delete all areas?',
  },
  deleteAllAreasScope: {
    id: 'liveBrowser.deleteAllAreasScope',
    defaultMessage:
      'This removes {areaCount, plural, one {# area} other {# areas}} and {regionCount, plural, one {# region} other {# regions}} from this chat only.',
  },
  deleteAllAreasHistory: {
    id: 'liveBrowser.deleteAllAreasHistory',
    defaultMessage:
      'It also removes {historyCount, plural, one {# history record} other {# history records}} and {captureCount, plural, one {# saved screenshot} other {# saved screenshots}}. This cannot be undone.',
  },
  cannotUndo: {
    id: 'liveBrowser.cannotUndo',
    defaultMessage: 'This cannot be undone.',
  },
  deleteAll: {
    id: 'liveBrowser.deleteAll',
    defaultMessage: 'Delete all',
  },
  cancel: {
    id: 'liveBrowser.cancel',
    defaultMessage: 'Cancel',
  },
  useAsArea: {
    id: 'liveBrowser.useAsArea',
    defaultMessage: 'Use as area',
  },
  potentialCandidateNotice: {
    id: 'liveBrowser.potentialCandidateNotice',
    defaultMessage:
      'Potential layout issue. The scan found a measurable condition; it does not prove a visual defect.',
  },
  potentialFindings: {
    id: 'liveBrowser.potentialFindings',
    defaultMessage: 'Potential findings',
  },
  elementNotFound: {
    id: 'liveBrowser.elementNotFound',
    defaultMessage: 'Element not found or binding is stale',
  },
  noPotentialCandidates: {
    id: 'liveBrowser.noPotentialCandidates',
    defaultMessage: 'No potential overflow candidates found.',
  },
  findingTextClipping: {
    id: 'liveBrowser.findingTextClipping',
    defaultMessage: 'Text clipping',
  },
  findingHorizontalOverflow: {
    id: 'liveBrowser.findingHorizontalOverflow',
    defaultMessage: 'Horizontal overflow',
  },
  findingVerticalOverflow: {
    id: 'liveBrowser.findingVerticalOverflow',
    defaultMessage: 'Vertical overflow',
  },
  findingElementOverlap: {
    id: 'liveBrowser.findingElementOverlap',
    defaultMessage: 'Element overlap',
  },
  potential: {
    id: 'liveBrowser.potential',
    defaultMessage: 'Potential',
  },
  findingOutdated: {
    id: 'liveBrowser.findingOutdated',
    defaultMessage: 'No longer detected · recheck',
  },
  evidenceSelection: {
    id: 'liveBrowser.evidenceSelection',
    defaultMessage: 'Selection',
  },
  evidenceReselection: {
    id: 'liveBrowser.evidenceReselection',
    defaultMessage: 'Reselection',
  },
  evidenceRecheck: {
    id: 'liveBrowser.evidenceRecheck',
    defaultMessage: 'Recheck',
  },
  statusDetected: {
    id: 'liveBrowser.statusDetected',
    defaultMessage: 'Detected',
  },
  statusConfirmed: {
    id: 'liveBrowser.statusConfirmed',
    defaultMessage: 'Confirmed',
  },
  statusInProgress: {
    id: 'liveBrowser.statusInProgress',
    defaultMessage: 'In progress',
  },
  statusFixed: {
    id: 'liveBrowser.statusFixed',
    defaultMessage: 'Fixed',
  },
  statusVerified: {
    id: 'liveBrowser.statusVerified',
    defaultMessage: 'Verified',
  },
  statusUnresolved: {
    id: 'liveBrowser.statusUnresolved',
    defaultMessage: 'Unresolved',
  },
  statusActive: {
    id: 'liveBrowser.statusActive',
    defaultMessage: 'Active',
  },
  statusCompleted: {
    id: 'liveBrowser.statusCompleted',
    defaultMessage: 'Completed',
  },
  statusDisputed: {
    id: 'liveBrowser.statusDisputed',
    defaultMessage: 'Disputed',
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
    defaultMessage: '{names} will be included in the next message to the agent',
  },
});

// All Live Browser panel copy uses react-intl descriptors. Russian catalog entries
// are translated; other locale catalogs intentionally use English fallback copy.
export const inlineMessages = defineMessages({
  '4k': {
    id: 'liveBrowser.inline.4k',
    defaultMessage: '4K',
  },
  'active-task': {
    id: 'liveBrowser.inline.active-task',
    defaultMessage: 'Active task',
  },
  'add-region': {
    id: 'liveBrowser.inline.add-region',
    defaultMessage: 'Add region',
  },
  'agent-is-controlling-the-page': {
    id: 'liveBrowser.inline.agent-is-controlling-the-page',
    defaultMessage: 'Agent is controlling the page',
  },
  'apply-viewport': {
    id: 'liveBrowser.inline.apply-viewport',
    defaultMessage: 'Apply viewport',
  },
  area: {
    id: 'liveBrowser.inline.area',
    defaultMessage: 'Area',
  },
  'area-name': {
    id: 'liveBrowser.inline.area-name',
    defaultMessage: 'Area name',
  },
  'area-status': {
    id: 'liveBrowser.inline.area-status',
    defaultMessage: 'Area status',
  },
  areas: {
    id: 'liveBrowser.inline.areas',
    defaultMessage: 'Areas',
  },
  'attach-to-message': {
    id: 'liveBrowser.inline.attach-to-message',
    defaultMessage: 'Attach to message',
  },
  auto: {
    id: 'liveBrowser.inline.auto',
    defaultMessage: 'Auto',
  },
  back: {
    id: 'liveBrowser.inline.back',
    defaultMessage: 'Back',
  },
  'bottom-inspector': {
    id: 'liveBrowser.inline.bottom-inspector',
    defaultMessage: 'Bottom inspector',
  },
  cancel: {
    id: 'liveBrowser.inline.cancel',
    defaultMessage: 'Cancel',
  },
  'close-areas': {
    id: 'liveBrowser.inline.close-areas',
    defaultMessage: 'Close areas',
  },
  'complete-task': {
    id: 'liveBrowser.inline.complete-task',
    defaultMessage: 'Complete task',
  },
  'completion-does-not-certify-a-fix': {
    id: 'liveBrowser.inline.completion-does-not-certify-a-fix',
    defaultMessage: 'Completion does not certify a fix',
  },
  connected: {
    id: 'liveBrowser.inline.connected',
    defaultMessage: 'Connected',
  },
  connecting: {
    id: 'liveBrowser.inline.connecting',
    defaultMessage: 'Connecting',
  },
  'delete-all': {
    id: 'liveBrowser.inline.delete-all',
    defaultMessage: 'Delete all',
  },
  'delete-all-areas': {
    id: 'liveBrowser.inline.delete-all-areas',
    defaultMessage: 'Delete all areas',
  },
  'delete-all-areas-2': {
    id: 'liveBrowser.inline.delete-all-areas-2',
    defaultMessage: 'Delete all areas?',
  },
  desktop: {
    id: 'liveBrowser.inline.desktop',
    defaultMessage: 'Desktop',
  },
  'dispute-result': {
    id: 'liveBrowser.inline.dispute-result',
    defaultMessage: 'Dispute result',
  },
  'drag-to-pan': {
    id: 'liveBrowser.inline.drag-to-pan',
    defaultMessage: 'Drag to pan',
  },
  'drag-to-select-esc-to-cancel': {
    id: 'liveBrowser.inline.drag-to-select-esc-to-cancel',
    defaultMessage: 'Drag to select • Esc to cancel',
  },
  'element-not-found-or-binding-is-stale': {
    id: 'liveBrowser.inline.element-not-found-or-binding-is-stale',
    defaultMessage: 'Element not found or binding is stale',
  },
  'evidence-history': {
    id: 'liveBrowser.inline.evidence-history',
    defaultMessage: 'Evidence & history',
  },
  expand: {
    id: 'liveBrowser.inline.expand',
    defaultMessage: 'Expand',
  },
  'find-area': {
    id: 'liveBrowser.inline.find-area',
    defaultMessage: 'Find area',
  },
  'find-area-2': {
    id: 'liveBrowser.inline.find-area-2',
    defaultMessage: 'Find area…',
  },
  'find-layout-candidates': {
    id: 'liveBrowser.inline.find-layout-candidates',
    defaultMessage: 'Find layout candidates',
  },
  fit: {
    id: 'liveBrowser.inline.fit',
    defaultMessage: 'Fit',
  },
  'for-example-the-button-needs-more-padding': {
    id: 'liveBrowser.inline.for-example-the-button-needs-more-padding',
    defaultMessage: 'For example: the button needs more padding.',
  },
  forward: {
    id: 'liveBrowser.inline.forward',
    defaultMessage: 'Forward',
  },
  'full-hd': {
    id: 'liveBrowser.inline.full-hd',
    defaultMessage: 'Full HD',
  },
  'hide-browser': {
    id: 'liveBrowser.inline.hide-browser',
    defaultMessage: 'Hide browser',
  },
  'hide-region-markers': {
    id: 'liveBrowser.inline.hide-region-markers',
    defaultMessage: 'Hide region markers',
  },
  'historical-evidence-not-current-page-state': {
    id: 'liveBrowser.inline.historical-evidence-not-current-page-state',
    defaultMessage: 'Historical evidence, not current page state',
  },
  'historical-selection-not-current-page': {
    id: 'liveBrowser.inline.historical-selection-not-current-page',
    defaultMessage: 'Historical selection, not current page',
  },
  'include-current-crop': {
    id: 'liveBrowser.inline.include-current-crop',
    defaultMessage: 'Include current crop',
  },
  'inspector-position': {
    id: 'liveBrowser.inline.inspector-position',
    defaultMessage: 'Inspector position',
  },
  'interact-with-page': {
    id: 'liveBrowser.inline.interact-with-page',
    defaultMessage: 'Interact with page',
  },
  'interaction-mode': {
    id: 'liveBrowser.inline.interaction-mode',
    defaultMessage: 'Interaction mode',
  },
  'legacy-claim-unverified': {
    id: 'liveBrowser.inline.legacy-claim-unverified',
    defaultMessage: 'Legacy claim • unverified',
  },
  mobile: {
    id: 'liveBrowser.inline.mobile',
    defaultMessage: 'Mobile',
  },
  'no-areas-yet-select-the-part-of-the-page-you-want-the-ai-to-inspect': {
    id: 'liveBrowser.inline.no-areas-yet-select-the-part-of-the-page-you-want-the-ai-to-inspect',
    defaultMessage: 'No areas yet. Select the part of the page you want the AI to inspect.',
  },
  'no-matching-areas': {
    id: 'liveBrowser.inline.no-matching-areas',
    defaultMessage: 'No matching areas.',
  },
  'no-potential-overflow-candidates-found': {
    id: 'liveBrowser.inline.no-potential-overflow-candidates-found',
    defaultMessage: 'No potential overflow candidates found.',
  },
  'no-project': {
    id: 'liveBrowser.inline.no-project',
    defaultMessage: 'No project',
  },
  'no-project-bound-choose-a-project-in-session-settings': {
    id: 'liveBrowser.inline.no-project-bound-choose-a-project-in-session-settings',
    defaultMessage: 'No project bound. Choose a project in session settings.',
  },
  'open-a-page-to-select': {
    id: 'liveBrowser.inline.open-a-page-to-select',
    defaultMessage: 'Open a page to select',
  },
  'open-an-address-above-select-a-region-when-you-need-the-agent-to-inspect-it': {
    id: 'liveBrowser.inline.open-an-address-above-select-a-region-when-you-need-the-agent-to-inspect-it',
    defaultMessage: 'Open an address above. Select a region when you need the agent to inspect it.',
  },
  'open-page': {
    id: 'liveBrowser.inline.open-page',
    defaultMessage: 'Open page',
  },
  'open-saved-page': {
    id: 'liveBrowser.inline.open-saved-page',
    defaultMessage: 'Open saved page',
  },
  'page-address': {
    id: 'liveBrowser.inline.page-address',
    defaultMessage: 'Page address',
  },
  'page-interaction': {
    id: 'liveBrowser.inline.page-interaction',
    defaultMessage: 'Page interaction',
  },
  'page-zoom': {
    id: 'liveBrowser.inline.page-zoom',
    defaultMessage: 'Page zoom',
  },
  'page-zoom-changes-the-page-preview-changes-only-its-presentation-middle-drag-pans-the-whee': {
    id: 'liveBrowser.inline.page-zoom-changes-the-page-preview-changes-only-its-presentation-middle-drag-pans-the-whee',
    defaultMessage:
      'Page zoom changes the page. Preview changes only its presentation. Middle drag pans; the wheel pans in Hand mode and scrolls the site in Interact mode.',
  },
  'pan-preview-middle-drag-also-works': {
    id: 'liveBrowser.inline.pan-preview-middle-drag-also-works',
    defaultMessage: 'Pan preview • middle drag also works',
  },
  potential: {
    id: 'liveBrowser.inline.potential',
    defaultMessage: 'Potential',
  },
  'potential-findings': {
    id: 'liveBrowser.inline.potential-findings',
    defaultMessage: 'Potential findings',
  },
  'potential-issue': {
    id: 'liveBrowser.inline.potential-issue',
    defaultMessage: 'Potential issue',
  },
  'potential-layout-issue-the-scan-found-a-measurable-condition-it-does-not-prove-a-visual-de': {
    id: 'liveBrowser.inline.potential-layout-issue-the-scan-found-a-measurable-condition-it-does-not-prove-a-visual-de',
    defaultMessage:
      'Potential layout issue. The scan found a measurable condition; it does not prove a visual defect.',
  },
  preview: {
    id: 'liveBrowser.inline.preview',
    defaultMessage: 'Preview',
  },
  'preview-scale': {
    id: 'liveBrowser.inline.preview-scale',
    defaultMessage: 'Preview scale',
  },
  'problem-description-what-should-be-fixed': {
    id: 'liveBrowser.inline.problem-description-what-should-be-fixed',
    defaultMessage: 'Problem description / what should be fixed',
  },
  'recheck-text-fitting': {
    id: 'liveBrowser.inline.recheck-text-fitting',
    defaultMessage: 'Recheck text fitting',
  },
  reconnect: {
    id: 'liveBrowser.inline.reconnect',
    defaultMessage: 'Reconnect',
  },
  reload: {
    id: 'liveBrowser.inline.reload',
    defaultMessage: 'Reload',
  },
  'remove-area': {
    id: 'liveBrowser.inline.remove-area',
    defaultMessage: 'Remove area',
  },
  'remove-region': {
    id: 'liveBrowser.inline.remove-region',
    defaultMessage: 'Remove region',
  },
  reselect: {
    id: 'liveBrowser.inline.reselect',
    defaultMessage: 'Reselect',
  },
  'reset-preview': {
    id: 'liveBrowser.inline.reset-preview',
    defaultMessage: 'Reset preview',
  },
  'resize-areas': {
    id: 'liveBrowser.inline.resize-areas',
    defaultMessage: 'Resize areas',
  },
  'resize-browser': {
    id: 'liveBrowser.inline.resize-browser',
    defaultMessage: 'Resize browser',
  },
  reveal: {
    id: 'liveBrowser.inline.reveal',
    defaultMessage: 'Reveal',
  },
  'select-a-region-for-ai': {
    id: 'liveBrowser.inline.select-a-region-for-ai',
    defaultMessage: 'Select a region for AI',
  },
  'select-area': {
    id: 'liveBrowser.inline.select-area',
    defaultMessage: 'Select area',
  },
  'show-on-page': {
    id: 'liveBrowser.inline.show-on-page',
    defaultMessage: 'Show on page',
  },
  'show-region-markers': {
    id: 'liveBrowser.inline.show-region-markers',
    defaultMessage: 'Show region markers',
  },
  'show-this-element-on-the-page': {
    id: 'liveBrowser.inline.show-this-element-on-the-page',
    defaultMessage: 'Show this element on the page',
  },
  'side-inspector': {
    id: 'liveBrowser.inline.side-inspector',
    defaultMessage: 'Side inspector',
  },
  split: {
    id: 'liveBrowser.inline.split',
    defaultMessage: 'Split',
  },
  tablet: {
    id: 'liveBrowser.inline.tablet',
    defaultMessage: 'Tablet',
  },
  'task-workflow': {
    id: 'liveBrowser.inline.task-workflow',
    defaultMessage: 'Task workflow',
  },
  'this-browser-is-attached-to-another-window-return-to-that-window-to-use-it': {
    id: 'liveBrowser.inline.this-browser-is-attached-to-another-window-return-to-that-window-to-use-it',
    defaultMessage: 'This browser is attached to another window. Return to that window to use it.',
  },
  'this-description-is-sent-to-ai-with-the-selected-area': {
    id: 'liveBrowser.inline.this-description-is-sent-to-ai-with-the-selected-area',
    defaultMessage: 'This description is sent to AI with the selected area.',
  },
  'use-as-area': {
    id: 'liveBrowser.inline.use-as-area',
    defaultMessage: 'Use as area',
  },
  'view-saved-crop': {
    id: 'liveBrowser.inline.view-saved-crop',
    defaultMessage: 'View saved crop',
  },
  viewport: {
    id: 'liveBrowser.inline.viewport',
    defaultMessage: 'Viewport',
  },
  'viewport-height': {
    id: 'liveBrowser.inline.viewport-height',
    defaultMessage: 'Viewport height',
  },
  'viewport-preset': {
    id: 'liveBrowser.inline.viewport-preset',
    defaultMessage: 'Viewport preset',
  },
  'viewport-width': {
    id: 'liveBrowser.inline.viewport-width',
    defaultMessage: 'Viewport width',
  },
  'your-browser-workspace': {
    id: 'liveBrowser.inline.your-browser-workspace',
    defaultMessage: 'Your browser workspace',
  },
});

const inlineMessageByEnglish = new Map(
  Object.values(inlineMessages).map((message) => [message.defaultMessage ?? '', message] as const)
);

export function liveBrowserInlineMessage(english: string) {
  const descriptor = inlineMessageByEnglish.get(english);
  if (!descriptor) throw new Error('Missing Live Browser message: ' + english);
  return descriptor;
}
