document.addEventListener('DOMContentLoaded', function() {
  const statusIndicator = document.querySelector('.status-indicator');
  const statusText = document.querySelector('.status-text');
  
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0] && tabs[0].url) {
      const url = new URL(tabs[0].url);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        statusIndicator.style.background = '#4CAF50';
        statusText.textContent = 'Protecting your passwords';
      } else {
        statusIndicator.style.background = '#999';
        statusText.textContent = 'Not active on this page';
      }
    }
  });
});