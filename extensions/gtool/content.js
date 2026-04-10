(function() {
  const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';
  
  const EYE_ICON_PATTERNS = [
    /eye/i,
    /show[-_]?password/i,
    /password[-_]?toggle/i,
    /visibility/i,
    /view[-_]?password/i,
    /unlock/i,
    /show/i,
    /hidden/i,
    /blick/i,
    /see[-_]?password/i
  ];

  const TOGGLE_CLASS_PATTERNS = [
    'password-toggle',
    'show-password',
    'eye-icon',
    'visibility-toggle',
    'password-visibility',
    'toggle-password',
    'input-password-toggle',
    'password-eye',
    'eye-btn',
    'show-pwd',
    'view-pwd',
    'pwd-toggle',
    'password-field-toggle',
    'reveal-password',
    'show-pwd-icon-button',
    'pwd-icon-button',
    'password-toggle-btn'
  ];

  function isLikelyPasswordToggle(element) {
    if (!element) return false;
    
    const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
    const title = (element.getAttribute('title') || '').toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();
    const type = (element.type || '').toLowerCase();
    const className = (element.className || '').toLowerCase();
    const id = (element.id || '').toLowerCase();
    const name = (element.name || '').toLowerCase();
    const placeholder = (element.getAttribute('placeholder') || '').toLowerCase();
    
    const textContent = (element.textContent || '').toLowerCase();
    const combinedText = `${ariaLabel} ${title} ${role} ${className} ${id} ${name} ${placeholder} ${textContent} ${type}`;

    if (EYE_ICON_PATTERNS.some(pattern => pattern.test(combinedText))) {
      return true;
    }

    if (TOGGLE_CLASS_PATTERNS.some(pattern => className.includes(pattern))) {
      return true;
    }

    return false;
  }

  function getSvgClassName(svg) {
    try {
      var c = svg.className;
      if (typeof c === 'string') return c;
      if (c && c.baseVal) return String(c.baseVal);
      return '';
    } catch(e) {
      return '';
    }
  }

  function isSvgEyeIcon(svg) {
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return false;
    
    const svgHtml = svg.innerHTML || '';
    const className = getSvgClassName(svg).toLowerCase();
    const id = (svg.id || '').toLowerCase();
    const combined = svgHtml + className + id;
    
    const eyePathPatterns = [
      /path.*d.*[mxzl].*[\d\s.,-]+.*[\d\s.,-]+/i,
      /circle.*cx.*cy.*r/i,
      /ellipse.*cx.*cy.*rx/i,
      /eye/i,
      /visibility/i,
      /show/i,
      /view/i
    ];
    
    return eyePathPatterns.some(pattern => pattern.test(combined));
  }

  function findToggleInContainer(container) {
    if (!container) return [];
    
    const toggles = [];
    const children = container.querySelectorAll('*');
    
    for (const child of children) {
      if (child === document.activeElement) continue;
      
      if (child.tagName.toLowerCase() === 'svg' && isSvgEyeIcon(child)) {
        toggles.push(child);
        continue;
      }
      
      if (child.tagName.toLowerCase() === 'button' || 
          child.tagName.toLowerCase() === 'span' ||
          child.tagName.toLowerCase() === 'i' ||
          child.getAttribute('role') === 'button') {
        if (isLikelyPasswordToggle(child)) {
          toggles.push(child);
        }
      }
    }
    
    return toggles;
  }

  function findAdjacentToggles(passwordInput) {
    const toggles = [];
    
    let sibling = passwordInput.nextElementSibling;
    for (let i = 0; i < 5 && sibling; i++, sibling = sibling.nextElementSibling) {
      if (isLikelyPasswordToggle(sibling) || isSvgEyeIcon(sibling)) {
        toggles.push(sibling);
      }
    }
    
    let prevSibling = passwordInput.previousElementSibling;
    for (let i = 0; i < 5 && prevSibling; i++, prevSibling = prevSibling.previousElementSibling) {
      if (isLikelyPasswordToggle(prevSibling) || isSvgEyeIcon(prevSibling)) {
        toggles.push(prevSibling);
      }
    }
    
    const parent = passwordInput.parentElement;
    if (parent) {
      const containerToggles = findToggleInContainer(parent);
      toggles.push(...containerToggles);
      
      const grandparent = parent.parentElement;
      if (grandparent) {
        const grandparentToggles = findToggleInContainer(grandparent);
        toggles.push(...grandparentToggles);
        
        const greatGrandparent = grandparent.parentElement;
        if (greatGrandparent) {
          const greatGrandparentToggles = findToggleInContainer(greatGrandparent);
          toggles.push(...greatGrandparentToggles);
        }
      }
    }
    
    const inputGroup = passwordInput.closest('.input-group, .inputGroup, .password-group, .form-group, .field-group, .custom-input-field-password-container, [class*="input-group"], [class*="password-group"], [class*="form-field"], [class*="input-field"], [class*="password-container"]');
    if (inputGroup) {
      const groupToggles = findToggleInContainer(inputGroup);
      toggles.push(...groupToggles);
    }
    
    return toggles;
  }

  function removeToggles() {
    const passwordInputs = document.querySelectorAll(PASSWORD_INPUT_SELECTOR);
    
    for (const input of passwordInputs) {
      const toggles = findAdjacentToggles(input);
      
      for (const toggle of toggles) {
        if (!toggle.dataset.gtoolRemoved) {
          toggle.dataset.gtoolRemoved = 'true';
          toggle.style.display = 'none';
          toggle.style.visibility = 'hidden';
          toggle.style.opacity = '0';
          toggle.style.pointerEvents = 'none';
          toggle.setAttribute('aria-hidden', 'true');
        }
      }
    }
    
    document.querySelectorAll('button.show-pwd-icon-button, button[class*="show-pwd-icon"]').forEach(btn => {
      if (!btn.dataset.gtoolRemoved) {
        btn.dataset.gtoolRemoved = 'true';
        btn.style.display = 'none';
        btn.style.visibility = 'hidden';
        btn.style.opacity = '0';
        btn.style.pointerEvents = 'none';
        btn.setAttribute('aria-hidden', 'true');
      }
    });
    
    const existingToggles = document.querySelectorAll('[data-gtool-removed="true"]');
    for (const toggle of existingToggles) {
      toggle.style.display = 'none';
      toggle.style.visibility = 'hidden';
      toggle.style.opacity = '0';
      toggle.style.pointerEvents = 'none';
    }
  }

  function init() {
    removeToggles();
    
    const observer = new MutationObserver((mutations) => {
      let shouldCheck = false;
      
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          shouldCheck = true;
          break;
        }
      }
      
      if (shouldCheck) {
        requestAnimationFrame(removeToggles);
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();