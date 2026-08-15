// Autofill Agent — public API barrel

export {
  // Profile CRUD
  saveProfile,
  loadProfile,
  deleteProfile,
  profileExists,
  createEmptyProfile,
  // Encryption
  encryptSensitive,
  decryptSensitive,
  // Export/Import
  exportProfile,
  importProfile,
  // Helpers
  addFormToProfile,
  getFormByUrlPattern,
  type RenterProfile,
  type LearnedForm,
  type FieldMapping,
  type FormAccessType,
} from "./profile";

export {
  // Form Detection
  detectForms,
  classifyField,
  classifyAccessType,
  buildSelector,
  findFieldLabel,
  type DetectedForm,
  type DetectedField,
} from "./detect";

export {
  // Form Recorder
  attachRecorder,
  stopRecording,
  saveRecording,
  isRecording,
  getRecordingState,
  validateRecording,
  detachRecorder,
  type RecordingState,
} from "./recorder";

export {
  // Form Replayer
  replayNoLogin,
  generateClipboardSummary,
  copyToClipboard,
  copyFieldToClipboard,
  showClipboardPanel,
  detectUserOverride,
  type ReplayResult,
} from "./replay";
