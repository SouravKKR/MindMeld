const localLlmDownloadStates =
{
  UNSUPPORTED: 0,
  NOT_STARTED: 1,
  DOWNLOADING: 2,
  READY: 3,
  DECLINED: 4,
  FAILED: 5,
}

module.exports = { localLlmDownloadStates };
