#ifndef FB_HTTPS_POLLING_H
#define FB_HTTPS_POLLING_H

// Increase the HTTPS hold window after empty responses, not the time spent
// disconnected. The server still checks the queue at most five seconds apart.
static inline unsigned FBHTTPSPollWaitMilliseconds(unsigned emptyResponses) {
  return emptyResponses == 0 ? 5000 : emptyResponses == 1 ? 10000 : 20000;
}

static inline unsigned FBHTTPSRetrySeconds(unsigned failures) {
  return failures <= 1 ? 15 : failures == 2 ? 30 : 60;
}

#endif
