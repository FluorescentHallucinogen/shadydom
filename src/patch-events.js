/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

'use strict';

import * as utils from './utils'
import {addEventListener as nativeAddEventListener,
  removeEventListener as nativeRemoveEventListener} from './native-methods'

// https://github.com/w3c/webcomponents/issues/513#issuecomment-224183937
let alwaysComposed = {
  'focusin': true,
  'focusout': true,
  'click': true,
  'dblclick': true,
  'mousedown': true,
  'mouseenter': true,
  'mouseleave': true,
  'mousemove': true,
  'mouseout': true,
  'mouseover': true,
  'mouseup': true,
  'wheel': true,
  'beforeinput': true,
  'input': true,
  'keydown': true,
  'keyup': true,
  'compositionstart': true,
  'compositionupdate': true,
  'compositionend': true,
  'touchstart': true,
  'touchend': true,
  'touchmove': true,
  'touchcancel': true,
  'pointerover': true,
  'pointerenter': true,
  'pointerdown': true,
  'pointermove': true,
  'pointerup': true,
  'pointercancel': true,
  'pointerout': true,
  'pointerleave': true,
  'gotpointercapture': true,
  'lostpointercapture': true,
  'dragstart': true,
  'drag': true,
  'dragenter': true,
  'dragleave': true,
  'dragover': true,
  'drop': true,
  'dragend': true,
  'DOMActivate': true,
  'DOMFocusIn': true,
  'DOMFocusOut': true,
  'keypress': true
};

function pathComposer(startNode, composed) {
  let composedPath = [];
  let current = startNode;
  let startRoot = startNode === window ? window : startNode.getRootNode();
  while (current) {
    composedPath.push(current);
    if (current.assignedSlot) {
      current = current.assignedSlot;
    } else if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && current.host && (composed || current !== startRoot)) {
      current = current.host;
    } else {
      current = current.parentNode;
    }
  }
  // event composedPath includes window when startNode's ownerRoot is document
  if (composedPath[composedPath.length - 1] === document) {
    composedPath.push(window);
  }
  return composedPath;
}

function retarget(refNode, path) {
  if (!utils.isShadyRoot) {
    return refNode;
  }
  // If ANCESTOR's root is not a shadow root or ANCESTOR's root is BASE's
  // shadow-including inclusive ancestor, return ANCESTOR.
  let refNodePath = pathComposer(refNode, true);
  let p$ = path;
  for (let i=0, ancestor, lastRoot, root, rootIdx; i < p$.length; i++) {
    ancestor = p$[i];
    root = ancestor === window ? window : ancestor.getRootNode();
    if (root !== lastRoot) {
      rootIdx = refNodePath.indexOf(root);
      lastRoot = root;
    }
    if (!utils.isShadyRoot(root) || rootIdx > -1) {
      return ancestor;
    }
  }
}

let eventMixin = {

  /**
   * @this {Event}
   */
  get composed() {
    // isTrusted may not exist in this browser, so just check if isTrusted is explicitly false
    if (this.isTrusted !== false && this.__composed === undefined) {
      this.__composed = alwaysComposed[this.type];
    }
    return this.__composed || false;
  },

  /**
   * @this {Event}
   */
  composedPath() {
    if (!this.__composedPath) {
      this.__composedPath = pathComposer(this['__target'], this.composed);
    }
    return this.__composedPath;
  },

  /**
   * @this {Event}
   */
  get target() {
    return retarget(this.currentTarget, this.composedPath());
  },

  // http://w3c.github.io/webcomponents/spec/shadow/#event-relatedtarget-retargeting
  /**
   * @this {Event}
   */
  get relatedTarget() {
    if (!this.__relatedTarget) {
      return null;
    }
    if (!this.__relatedTargetComposedPath) {
      this.__relatedTargetComposedPath = pathComposer(this.__relatedTarget, true);
    }
    // find the deepest node in relatedTarget composed path that is in the same root with the currentTarget
    return retarget(this.currentTarget, this.__relatedTargetComposedPath);
  },
  /**
   * @this {Event}
   */
  stopPropagation() {
    Event.prototype.stopPropagation.call(this);
    this.__propagationStopped = true;
  },
  /**
   * @this {Event}
   */
  stopImmediatePropagation() {
    Event.prototype.stopImmediatePropagation.call(this);
    this.__immediatePropagationStopped = true;
    this.__propagationStopped = true;
  }

};

function mixinComposedFlag(Base) {
  // NOTE: avoiding use of `class` here so that transpiled output does not
  // try to do `Base.call` with a dom construtor.
  let klazz = function(type, options) {
    let event = new Base(type, options);
    event.__composed = options && Boolean(options['composed']);
    return event;
  }
  // put constructor properties on subclass
  utils.mixin(klazz, Base);
  klazz.prototype = Base.prototype;
  return klazz;
}

let nonBubblingEventsToRetarget = {
  'focus': true,
  'blur': true
};


function fireHandlers(event, node, phase) {
  let hs = node.__handlers && node.__handlers[event.type] &&
    node.__handlers[event.type][phase];
  if (hs) {
    for (let i = 0, fn; (fn = hs[i]); i++) {
      fn.call(node, event);
      if (event.__immediatePropagationStopped) {
        return;
      }
    }
  }
}

function retargetNonBubblingEvent(e) {
  let path = e.composedPath();
  let node;
  // override `currentTarget` to let patched `target` calculate correctly
  Object.defineProperty(e, 'currentTarget', {
    get: function() {
      return node;
    },
    configurable: true
  });
  for (let i = path.length - 1; i >= 0; i--) {
    node = path[i];
    // capture phase fires all capture handlers
    fireHandlers(e, node, 'capture');
    if (e.__propagationStopped) {
      return;
    }
  }

  // set the event phase to `AT_TARGET` as in spec
  Object.defineProperty(e, 'eventPhase', {value: Event.AT_TARGET});

  // the event only needs to be fired when owner roots change when iterating the event path
  // keep track of the last seen owner root
  let lastFiredRoot;
  for (let i = 0; i < path.length; i++) {
    node = path[i];
    if (i === 0 || (node.shadowRoot && node.shadowRoot === lastFiredRoot)) {
      fireHandlers(e, node, 'bubble');
      // don't bother with window, it doesn't have `getRootNode` and will be last in the path anyway
      if (node !== window) {
        lastFiredRoot = node.getRootNode();
      }
      if (e.__propagationStopped) {
        return;
      }
    }
  }
}

/**
 * @this {Event}
 */
export function addEventListener(type, fn, optionsOrCapture) {
  if (!fn) {
    return;
  }

  // The callback `fn` might be used for multiple nodes/events. Since we generate
  // a wrapper function, we need to keep track of it when we remove the listener.
  // It's more efficient to store the node/type/options information as Array in
  // `fn` itself rather than the node (we assume that the same callback is used
  // for few nodes at most, whereas a node will likely have many event listeners).
  // NOTE(valdrin) invoking external functions is costly, inline has better perf.
  let capture, once, passive;
  if (typeof optionsOrCapture === 'object') {
    capture = Boolean(optionsOrCapture.capture);
    once = Boolean(optionsOrCapture.once);
    passive = Boolean(optionsOrCapture.passive);
  } else {
    capture = Boolean(optionsOrCapture);
    once = false;
    passive = false;
  }
  if (fn.__eventWrappers) {
    // Stop if the wrapper function has already been created.
    for (let i = 0; i < fn.__eventWrappers.length; i++) {
      if (fn.__eventWrappers[i].node === this &&
          fn.__eventWrappers[i].type === type &&
          fn.__eventWrappers[i].capture === capture &&
          fn.__eventWrappers[i].once === once &&
          fn.__eventWrappers[i].passive === passive) {
        return;
      }
    }
  } else {
    fn.__eventWrappers = [];
  }

  /**
   * @this {HTMLElement}
   */
  const wrapperFn = function(e) {
    // Support `once` option.
    if (once) {
      this.removeEventListener(type, fn, optionsOrCapture);
    }
    if (!e['__target']) {
      patchEvent(e);
    }
    // There are two critera that should stop events from firing on this node
    // 1. the event is not composed and the current node is not in the same root as the target
    // 2. when bubbling, if after retargeting, relatedTarget and target point to the same node
    if (e.composed || e.composedPath().indexOf(this) > -1) {
      if (e.eventPhase === Event.BUBBLING_PHASE) {
        if (e.target === e.relatedTarget) {
          e.stopImmediatePropagation();
          return;
        }
      }
      return fn(e);
    }
  };
  // Store the wrapper information.
  fn.__eventWrappers.push({
    node: this,
    type: type,
    capture: capture,
    once: once,
    passive: passive,
    wrapperFn: wrapperFn
  });

  if (nonBubblingEventsToRetarget[type]) {
    this.__handlers = this.__handlers || {};
    this.__handlers[type] = this.__handlers[type] ||
      {'capture': [], 'bubble': []};
    this.__handlers[type][capture ? 'capture' : 'bubble'].push(wrapperFn);
  } else {
    nativeAddEventListener.call(this, type, wrapperFn, optionsOrCapture);
  }
}

/**
 * @this {Event}
 */
export function removeEventListener(type, fn, optionsOrCapture) {
  if (!fn) {
    return;
  }

  // NOTE(valdrin) invoking external functions is costly, inline has better perf.
  let capture, once, passive;
  if (typeof optionsOrCapture === 'object') {
    capture = Boolean(optionsOrCapture.capture);
    once = Boolean(optionsOrCapture.once);
    passive = Boolean(optionsOrCapture.passive);
  } else {
    capture = Boolean(optionsOrCapture);
    once = false;
    passive = false;
  }
  // Search the wrapped function.
  let wrapperFn = undefined;
  if (fn.__eventWrappers) {
    for (let i = 0; i < fn.__eventWrappers.length; i++) {
      if (fn.__eventWrappers[i].node === this &&
          fn.__eventWrappers[i].type === type &&
          fn.__eventWrappers[i].capture === capture &&
          fn.__eventWrappers[i].once === once &&
          fn.__eventWrappers[i].passive === passive) {
        wrapperFn = fn.__eventWrappers.splice(i, 1)[0].wrapperFn;
        // Cleanup.
        if (!fn.__eventWrappers.length) {
          fn.__eventWrappers = undefined;
        }
        break;
      }
    }
  }

  nativeRemoveEventListener.call(this, type, wrapperFn || fn, optionsOrCapture);
  if (wrapperFn && nonBubblingEventsToRetarget[type] &&
      this.__handlers && this.__handlers[type]) {
    const arr = this.__handlers[type][capture ? 'capture' : 'bubble'];
    const idx = arr.indexOf(wrapperFn);
    if (idx > -1) {
      arr.splice(idx, 1);
    }
  }
}

function activateFocusEventOverrides() {
  for (let ev in nonBubblingEventsToRetarget) {
    window.addEventListener(ev, function(e) {
      if (!e['__target']) {
        patchEvent(e);
        retargetNonBubblingEvent(e);
        e.stopImmediatePropagation();
      }
    }, true);
  }
}

function patchEvent(event) {
  event['__target'] = event.target;
  event.__relatedTarget = event.relatedTarget;
  // patch event prototype if we can
  if (utils.settings.hasDescriptors) {
    utils.patchPrototype(event, eventMixin);
  // and fallback to patching instance
  } else {
    utils.extend(event, eventMixin);
  }
}

let PatchedEvent = mixinComposedFlag(window.Event);
let PatchedCustomEvent = mixinComposedFlag(window.CustomEvent);
let PatchedMouseEvent = mixinComposedFlag(window.MouseEvent);

export function patchEvents() {
  window.Event = PatchedEvent;
  window.CustomEvent = PatchedCustomEvent;
  window.MouseEvent = PatchedMouseEvent;
  activateFocusEventOverrides();
}
