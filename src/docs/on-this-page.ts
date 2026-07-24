/**
 * On This Page: tree building + scroll spy logic for API Docs
 * 
 * Provides helpers to build a structured TOC tree from heading IDs,
 * track the active section, and render expand/collapse client scripts.
 */

import { PORTAL_SVGS } from "../portal/shell.js";

export interface TocSection {
  id: string;
  label: string;
  children?: TocChild[];
}

export interface TocChild {
  id: string;
  label: string;
}

/**
 * Build the On This Page tree structure.
 * Includes guide subsections, all mutations, and all schema types.
 */
export function buildTocTree(
  types: Array<{ name: string }>,
  mutations: Array<{ name: string }>
): TocSection[] {
  return [
    {
      id: "guide",
      label: "Build Your First Integration",
      children: [
        { id: "guide-model", label: "The mental model" },
        { id: "guide-setup", label: "Get set up" },
        { id: "guide-first-request", label: "Your first request" },
        { id: "guide-real-query", label: "Pull real data" },
        { id: "guide-by-location", label: "Slice by location" },
        { id: "guide-next", label: "Where to go next" },
      ],
    },
    {
      id: "introduction",
      label: "Introduction",
    },
    {
      id: "features",
      label: "What You Can Do",
    },
    {
      id: "quick-start",
      label: "Quick Start",
    },
    {
      id: "authentication",
      label: "Authentication",
    },
    {
      id: "queries",
      label: "Queries",
    },
    {
      id: "mutations",
      label: "Mutations",
      children: mutations.map((m) => ({
        id: `mutation-${m.name.toLowerCase()}`,
        label: m.name,
      })),
    },
    {
      id: "types",
      label: "Types",
      children: types.map((t) => ({
        id: `type-${t.name.toLowerCase()}`,
        label: t.name,
      })),
    },
  ];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render On This Page HTML with expand/collapse structure
 */
export function renderOnThisPage(sections: TocSection[]): string {
  const renderSection = (section: TocSection) => {
    const hasChildren = section.children && section.children.length > 0;
    
    if (!hasChildren) {
      return `<a href="#${section.id}" class="toc-link" data-section="${section.id}">${escapeHtml(section.label)}</a>`;
    }
    
    return `
      <div class="toc-section" data-section="${section.id}">
        <a href="#${section.id}" class="toc-link toc-parent" data-section="${section.id}">
          ${escapeHtml(section.label)}
        </a>
        <div class="toc-children">
          ${section.children!.map((child) => 
            `<a href="#${child.id}" class="toc-link toc-child" data-section="${section.id}" data-child="${child.id}">${escapeHtml(child.label)}</a>`
          ).join("")}
        </div>
      </div>
    `;
  };
  
  const listIcon =
    '<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M3 5h14v1.5H3V5zm0 4.25h14V10.75H3V9.25zm0 4.25h14V15H3v-1.5z"/></svg>';
  const closeIcon = PORTAL_SVGS.close;

  return `
    <aside class="docs-toc" id="docs-toc">
      <button type="button" class="toc-collapse-btn" onclick="toggleTocCollapse()" aria-label="Toggle On This Page search" title="Search">
        ${PORTAL_SVGS.search}
      </button>
      <button type="button" class="toc-sheet-close" onclick="closeTocSheet()" aria-label="Close On This Page">
        ${closeIcon}
      </button>
      <div class="toc-content">
        <div class="toc-heading">On This Page</div>
        <div class="toc-search">
          <input 
            type="text" 
            id="toc-search-input" 
            class="toc-search-input" 
            placeholder="Search (⌘K)"
            aria-label="Search documentation"
          />
        </div>
        <div class="toc-sections">
          ${sections.map(renderSection).join("")}
        </div>
      </div>
    </aside>
    <button type="button" id="mobile-toc-toggle" onclick="openTocSheet()" aria-label="On This Page">
      ${listIcon}
      <span>On This Page</span>
    </button>
    <div id="toc-overlay" onclick="closeTocSheet()"></div>
  `;
}

/**
 * Client-side script for On This Page behavior:
 * - Scroll spy with active highlighting
 * - Expand/collapse sections
 * - Smooth scroll on click
 * - Mobile sheet control
 */
export function renderOnThisPageScript(): string {
  return `
    // Shared nav lock — prevents scroll-spy from expanding Mutations (etc.)
    // mid-flight and fighting window.scrollTo({ behavior: 'smooth' }).
    var tocIsNavigating = false;
    var tocNavTimer = null;
    // Last TOC href we jumped to — arrow keys resume from here, not the top.
    var tocLastNavHref = null;
    function beginTocNavigation(ms) {
      tocIsNavigating = true;
      if (tocNavTimer) clearTimeout(tocNavTimer);
      tocNavTimer = setTimeout(function() {
        tocIsNavigating = false;
        tocNavTimer = null;
        if (typeof window.__tocUpdateActive === 'function') {
          window.__tocUpdateActive();
        }
      }, ms || 1200);
    }

    // Toggle TOC collapse/expand (desktop). Expanding focuses search.
    function toggleTocCollapse() {
      var toc = document.querySelector('.docs-toc');
      if (!toc) return;
      var wasCollapsed = toc.classList.contains('collapsed');
      toc.classList.toggle('collapsed');
      if (wasCollapsed) {
        var search = document.getElementById('toc-search-input');
        if (search) search.focus();
      }
    }
    
    function isTocSheetMode() {
      return window.matchMedia('(max-width: 1100px)').matches;
    }

    function openTocSheet() {
      var toc = document.getElementById('docs-toc');
      var overlay = document.getElementById('toc-overlay');
      if (!toc || !overlay) return;
      toc.classList.add('sheet-open');
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
      var search = document.getElementById('toc-search-input');
      if (search) search.focus();
    }

    function closeTocSheet() {
      var toc = document.getElementById('docs-toc');
      var overlay = document.getElementById('toc-overlay');
      if (toc) toc.classList.remove('sheet-open');
      if (overlay) overlay.classList.remove('active');
      document.body.style.overflow = '';
    }

    // ESC: close mobile sheet, else blur search, else collapse desktop TOC
    (function() {
      var searchInput = document.getElementById('toc-search-input');
      var toc = document.getElementById('docs-toc');
      
      document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        if (toc && toc.classList.contains('sheet-open')) {
          closeTocSheet();
          return;
        }
        if (searchInput && document.activeElement === searchInput) {
          searchInput.blur();
        } else if (toc && !toc.classList.contains('collapsed') && !isTocSheetMode()) {
          toc.classList.add('collapsed');
        }
      });
    })();
    
    // TOC search functionality
    (function() {
      var searchInput = document.getElementById('toc-search-input');
      if (!searchInput) return;
      
      // Cmd/Ctrl+K to focus search (and expand TOC if collapsed)
      document.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          var toc = document.querySelector('.docs-toc');
          // Expand TOC if collapsed
          if (toc && toc.classList.contains('collapsed')) {
            toc.classList.remove('collapsed');
          }
          // Focus search input
          searchInput.focus();
        }
      });
      
      // Search filter with keyboard navigation
      var selectedIndex = -1;
      var visibleLinks = [];
      
      function updateVisibleLinks() {
        // Get all visible links, but exclude children from collapsed sections
        var allLinks = Array.from(document.querySelectorAll('.toc-link:not(.search-hidden)'));
        var searchActive = searchInput && searchInput.value.trim().length > 0;
        
        visibleLinks = allLinks.filter(function(link) {
          // During search, exclude parent links - only navigate to actual content
          if (searchActive && link.classList.contains('toc-parent')) {
            return false;
          }
          
          // Always include parent/title links when not searching
          if (link.classList.contains('toc-parent')) {
            return true;
          }
          
          // For child links, only include if parent section is expanded
          if (link.classList.contains('toc-child')) {
            var section = link.closest('.toc-section');
            return section && section.classList.contains('expanded');
          }
          
          // Include standalone links (no parent/child relationship)
          return true;
        });
      }
      
      function highlightSelected() {
        visibleLinks.forEach(function(link, i) {
          if (i === selectedIndex) {
            link.classList.add('search-selected');
          } else {
            link.classList.remove('search-selected');
          }
        });
        
        // Scroll selected item into view
        if (selectedIndex >= 0 && visibleLinks[selectedIndex]) {
          visibleLinks[selectedIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }

      /** Index of the current page section in visibleLinks (last jump, else .active). */
      function indexOfCurrentInVisible() {
        if (tocLastNavHref) {
          for (var i = 0; i < visibleLinks.length; i++) {
            if (visibleLinks[i].getAttribute('href') === tocLastNavHref) return i;
          }
        }
        var active = document.querySelector('.toc-link.active');
        if (active) {
          var idx = visibleLinks.indexOf(active);
          if (idx >= 0) return idx;
        }
        return -1;
      }
      
      function navigateToLink(link) {
        if (!link) return;
        
        var href = link.getAttribute('href');
        if (!href || !href.startsWith('#')) return;
        var targetId = href.slice(1);
        var target = document.getElementById(targetId);
        if (!target) return;

        var destSection = link.getAttribute('data-section');

        // Only expand the destination section — never Mutations when jumping to Types
        document.querySelectorAll('.toc-section').forEach(function(section) {
          var id = section.getAttribute('data-section');
          if (id === destSection && link.classList.contains('toc-child')) {
            section.classList.add('expanded');
          } else if (id === 'mutations' && destSection !== 'mutations') {
            section.classList.remove('expanded');
          }
        });

        tocLastNavHref = href;
        document.querySelectorAll('.toc-link').forEach(function(l) {
          l.classList.remove('active');
        });
        link.classList.add('active');

        beginTocNavigation(1200);
        if (isTocSheetMode()) {
          closeTocSheet();
        }

        var targetPosition = target.getBoundingClientRect().top + window.scrollY;
        var offset = 100;
        window.scrollTo({
          top: targetPosition - offset,
          behavior: 'smooth'
        });
        history.pushState(null, '', href);
      }
      
      searchInput.addEventListener('input', function() {
        var query = searchInput.value.toLowerCase().trim();
        var sections = document.querySelectorAll('.toc-section');
        var links = document.querySelectorAll('.toc-link:not(.toc-parent)');
        
        // Reset selection when query changes
        selectedIndex = -1;
        
        // Remove all search-selected classes
        document.querySelectorAll('.toc-link').forEach(function(link) {
          link.classList.remove('search-selected');
        });
        
        if (!query) {
          // Show all
          sections.forEach(function(s) { s.classList.remove('search-hidden'); });
          links.forEach(function(l) { 
            l.classList.remove('search-hidden');
          });
          updateVisibleLinks();
          return;
        }
        
        // Filter sections and links
        sections.forEach(function(section) {
          var parentLink = section.querySelector('.toc-parent');
          var label = parentLink.textContent.toLowerCase();
          var hasMatch = label.includes(query);
          var hasChildMatch = false;
          
          // Check children
          var children = section.querySelectorAll('.toc-child');
          children.forEach(function(child) {
            var childLabel = child.textContent.toLowerCase();
            if (childLabel.includes(query)) {
              child.classList.remove('search-hidden');
              hasChildMatch = true;
            } else {
              child.classList.add('search-hidden');
            }
          });
          
          // If parent matches but no children match, show all children
          // This handles cases like searching "types" or "mutations"
          if (hasMatch && !hasChildMatch && children.length > 0) {
            children.forEach(function(child) {
              child.classList.remove('search-hidden');
            });
            hasChildMatch = true;
          }
          
          // Show section if parent or any child matches
          if (hasMatch || hasChildMatch) {
            section.classList.remove('search-hidden');
            if (hasChildMatch || hasMatch) {
              section.classList.add('expanded'); // Auto-expand if match
            }
          } else {
            section.classList.add('search-hidden');
          }
        });
        
        // Filter standalone links
        links.forEach(function(link) {
          if (link.classList.contains('toc-child')) return; // Already handled
          var label = link.textContent.toLowerCase();
          if (label.includes(query)) {
            link.classList.remove('search-hidden');
          } else {
            link.classList.add('search-hidden');
          }
        });
        
        // Update visible links after filtering
        updateVisibleLinks();
        
        // Auto-select first result if there's a query and results exist
        if (query && visibleLinks.length > 0) {
          selectedIndex = 0;
          highlightSelected();
        }
      });
      
      // Arrow key navigation and Enter to select
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
          // Always update visible links before handling navigation keys
          updateVisibleLinks();
        }
        
        if (visibleLinks.length === 0) return;
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          // First press anchors on the landed/active item; later presses move down
          if (selectedIndex === -1) {
            var fromDown = indexOfCurrentInVisible();
            selectedIndex = fromDown >= 0 ? fromDown : 0;
          } else {
            selectedIndex = Math.min(selectedIndex + 1, visibleLinks.length - 1);
          }
          highlightSelected();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (selectedIndex === -1) {
            var fromUp = indexOfCurrentInVisible();
            selectedIndex = fromUp >= 0 ? fromUp : visibleLinks.length - 1;
          } else {
            selectedIndex = Math.max(selectedIndex - 1, 0);
          }
          highlightSelected();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          
          // Prefer keyboard selection, else the landed/active section, else first result
          var targetIndex = selectedIndex;
          if (targetIndex < 0) targetIndex = indexOfCurrentInVisible();
          if (targetIndex < 0) targetIndex = 0;
          var targetLink = visibleLinks[targetIndex];
          
          if (targetLink) {
            // Clear search UI before navigating so filters don't leave Mutations open
            searchInput.value = '';
            selectedIndex = -1;
            document.querySelectorAll('.toc-section').forEach(function(s) {
              s.classList.remove('search-hidden');
            });
            document.querySelectorAll('.toc-link').forEach(function(l) {
              l.classList.remove('search-hidden');
              l.classList.remove('search-selected');
            });
            updateVisibleLinks();
            navigateToLink(targetLink);
          }
        }
      });
    })();
    
    // On This Page: scroll spy + expand/collapse + smooth scroll
    (function() {
      var tocLinks = document.querySelectorAll('.toc-link');
      var headings = [];
      
      // Build heading registry. Mutation children are omitted from scroll-spy —
      // there are dozens of table-row anchors, and treating them as active
      // expands the Mutations TOC mid-scroll (derails jumps to Types).
      tocLinks.forEach(function(link) {
        var id = link.getAttribute('href');
        if (id && id.startsWith('#')) {
          var sectionId = link.getAttribute('data-section');
          var childId = link.getAttribute('data-child');
          if (sectionId === 'mutations' && childId) {
            return;
          }
          var el = document.getElementById(id.slice(1));
          if (el) {
            headings.push({
              el: el,
              link: link,
              section: sectionId,
              child: childId,
            });
          }
        }
      });
      
      var currentActiveSection = null;
      
      function updateActive() {
        // Don't update if user just clicked / searched to navigate
        if (tocIsNavigating) return;
        
        var scrollY = window.scrollY;
        var offset = 150; // Offset from top of viewport
        
        var current = headings[0];
        var currentIndex = 0;
        
        // Find the heading closest to but above the scroll position
        for (var i = 0; i < headings.length; i++) {
          // Use getBoundingClientRect for accurate position, works for table rows too
          var rect = headings[i].el.getBoundingClientRect();
          var elementTop = rect.top + scrollY;
          
          if (elementTop <= scrollY + offset) {
            current = headings[i];
            currentIndex = i;
          } else {
            // Stop once we hit a heading that's below our position
            break;
          }
        }
        
        if (!current) return;
        
        // Remove all active and read states
        tocLinks.forEach(function(l) { 
          l.classList.remove('active');
          l.classList.remove('read');
        });
        
        // Mark all items above current as read
        for (var i = 0; i < currentIndex; i++) {
          headings[i].link.classList.add('read');
        }
        
        // Mark current link active
        current.link.classList.add('active');
        
        // Auto-scroll to active item in TOC if user isn't manually scrolling it
        var tocContainer = document.querySelector('.docs-toc');
        if (tocContainer && !tocContainer.dataset.userScrolling) {
          var activeLink = current.link;
          var tocRect = tocContainer.getBoundingClientRect();
          var linkRect = activeLink.getBoundingClientRect();
          
          // Check if active link is outside the visible TOC area
          if (linkRect.top < tocRect.top || linkRect.bottom > tocRect.bottom) {
            activeLink.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
        
        // Expand/collapse: never auto-open Mutations (too many children).
        // Keep it open only if the user already expanded it and we're still there.
        var newActiveSection = current.child ? current.section : null;
        var mutationsWasOpen = false;
        var mutationsSection = document.querySelector('.toc-section[data-section="mutations"]');
        if (mutationsSection) {
          mutationsWasOpen = mutationsSection.classList.contains('expanded');
        }

        document.querySelectorAll('.toc-section').forEach(function(section) {
          var id = section.getAttribute('data-section');
          if (id === 'mutations') {
            if (newActiveSection === 'mutations' && mutationsWasOpen) {
              // stay open while browsing the Mutations block
            } else {
              section.classList.remove('expanded');
            }
            return;
          }
          section.classList.remove('expanded');
        });
        
        if (newActiveSection && newActiveSection !== 'mutations') {
          var activeSection = document.querySelector('.toc-section[data-section="' + newActiveSection + '"]');
          if (activeSection) {
            activeSection.classList.add('expanded');
          }
        }
        
        currentActiveSection = newActiveSection;
      }

      window.__tocUpdateActive = updateActive;
      
      // Click-to-toggle for parent sections (guide, types, etc.)
      document.querySelectorAll('.toc-parent').forEach(function(parent) {
        parent.addEventListener('click', function(e) {
          var section = parent.closest('.toc-section');
          if (!section) return;
          
          var isExpanded = section.classList.contains('expanded');
          var targetId = parent.getAttribute('href');
          
          if (isExpanded && targetId) {
            // If already expanded, toggle collapse instead of navigating
            e.preventDefault();
            section.classList.remove('expanded');
          } else {
            // If collapsed, expand and allow scroll (handled by smooth scroll below)
            section.classList.add('expanded');
          }
        });
      });
      
      // Smooth scroll on click with navigation lock
      tocLinks.forEach(function(link) {
        link.addEventListener('click', function(e) {
          e.preventDefault();

          var destSection = link.getAttribute('data-section');
          // Collapse Mutations when jumping elsewhere so it can't inflate mid-scroll
          if (destSection !== 'mutations') {
            var mut = document.querySelector('.toc-section[data-section="mutations"]');
            if (mut) mut.classList.remove('expanded');
          } else if (link.classList.contains('toc-child')) {
            var mutOpen = document.querySelector('.toc-section[data-section="mutations"]');
            if (mutOpen) mutOpen.classList.add('expanded');
          }

          var href = link.getAttribute('href');
          tocLastNavHref = href;
          document.querySelectorAll('.toc-link').forEach(function(l) {
            l.classList.remove('active');
          });
          link.classList.add('active');

          beginTocNavigation(1200);

          if (isTocSheetMode()) {
            closeTocSheet();
          }
          
          var id = href.slice(1);
          var target = document.getElementById(id);
          if (target) {
            var targetPosition = target.getBoundingClientRect().top + window.scrollY;
            var offset = 100;
            
            window.scrollTo({
              top: targetPosition - offset,
              behavior: 'smooth'
            });
            
            history.pushState(null, '', '#' + id);
          }
        });
      });
      
      // Initial update + scroll listener
      updateActive();
      window.addEventListener('scroll', updateActive, { passive: true });
      
      // Track user scrolling in TOC to prevent auto-scroll interference
      var tocContainer = document.getElementById('docs-toc');
      if (tocContainer) {
        var scrollTimeout;
        tocContainer.addEventListener('scroll', function() {
          tocContainer.dataset.userScrolling = 'true';
          clearTimeout(scrollTimeout);
          scrollTimeout = setTimeout(function() {
            delete tocContainer.dataset.userScrolling;
          }, 150);
        }, { passive: true });
      }
    })();
  `;
}

/**
 * CSS styles for On This Page expand/collapse + mobile sheet
 */
export function renderOnThisPageStyles(): string {
  return `
    /* On This Page as floating card (desktop) */
    .docs-toc {
      position: sticky;
      top: 24px;
      max-height: calc(100vh - 48px);
      overflow-y: auto;
      background: var(--color-surface);
      border: 1px solid rgba(0, 0, 0, 0.06);
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
      z-index: 10;
      width: 260px;
      flex-shrink: 0;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .docs-toc.collapsed {
      width: 48px;
      height: 48px;
      padding: 0;
      overflow: hidden;
      cursor: pointer;
    }
    
    .toc-collapse-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      color: var(--color-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.2s, color 0.2s;
      z-index: 1;
    }
    
    .toc-collapse-btn:hover {
      background: rgba(0, 0, 0, 0.05);
      color: var(--color-text);
    }
    
    .docs-toc.collapsed .toc-collapse-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 24px;
      height: 24px;
      color: var(--color-text);
    }
    
    .docs-toc.collapsed .toc-content {
      display: none;
    }
    
    /* TOC search bar */
    .toc-search {
      margin: 12px 0;
    }
    
    .toc-search-input {
      width: 100%;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 6px;
      color: var(--color-text);
      font-size: 0.875rem;
      font-family: var(--font);
      transition: all 0.2s;
    }
    
    .toc-search-input:focus {
      outline: none;
      background: rgba(0, 0, 0, 0.08);
      border-color: var(--color-accent);
    }
    
    .toc-search-input::placeholder {
      color: var(--color-muted);
      opacity: 0.6;
    }
    
    .toc-sections {
      margin-top: 12px;
    }
    
    .toc-link.search-hidden {
      display: none;
    }
    
    .toc-section.search-hidden {
      display: none;
    }
    
    .toc-link.search-selected {
      background: rgba(255, 120, 43, 0.15);
      color: var(--color-accent);
      font-weight: 500;
    }
    
    /* On This Page section expansion */
    .toc-section {
      margin-bottom: 0.5rem;
    }
    
    .toc-parent {
      font-weight: 500;
    }
    
    .toc-children {
      max-height: 0;
      overflow: hidden;
      opacity: 0;
      transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
    }
    
    .toc-section.expanded .toc-children {
      max-height: none;
      opacity: 1;
    }
    
    .toc-child {
      padding-left: 1rem;
      font-size: 0.75rem;
    }
    
    /* Scrollbar styling for TOC */
    .docs-toc::-webkit-scrollbar {
      width: 6px;
    }
    
    .docs-toc::-webkit-scrollbar-track {
      background: transparent;
    }
    
    .docs-toc::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 3px;
    }
    
    .docs-toc::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.22);
    }

    .toc-sheet-close {
      display: none;
    }

    #mobile-toc-toggle {
      display: none;
      position: fixed;
      bottom: 20px;
      right: 16px;
      z-index: 170;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 999px;
      color: var(--color-text);
      font-size: 0.8125rem;
      font-weight: 600;
      font-family: var(--font);
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    #mobile-toc-toggle:hover {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }

    #toc-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 165;
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    #toc-overlay.active {
      display: block;
      opacity: 1;
    }
    
    /* Mobile / narrow: On This Page sheet from the right */
    @media (max-width: 1100px) {
      .toc-collapse-btn {
        display: none;
      }
      .toc-sheet-close {
        display: flex;
        position: absolute;
        top: 12px;
        right: 12px;
        width: 32px;
        height: 32px;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: var(--color-muted);
        cursor: pointer;
        border-radius: 6px;
        z-index: 2;
      }
      .toc-sheet-close:hover {
        color: var(--color-text);
        background: var(--color-surface-2);
      }
      #mobile-toc-toggle {
        display: inline-flex;
      }
      body.modal-open #mobile-toc-toggle,
      .docs-toc.sheet-open ~ #mobile-toc-toggle {
        display: none;
      }
      .docs-toc {
        position: fixed;
        top: 0;
        right: 0;
        width: min(320px, 88vw);
        height: 100vh;
        max-height: 100vh;
        border-radius: 0;
        border: none;
        border-left: 1px solid var(--color-border);
        box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 175;
        padding: 1.25rem 1.25rem 2rem;
      }
      .docs-toc.collapsed {
        width: min(320px, 88vw);
        height: 100vh;
        padding: 1.25rem 1.25rem 2rem;
        overflow-y: auto;
        cursor: default;
      }
      .docs-toc.collapsed .toc-content {
        display: block;
      }
      .docs-toc.sheet-open {
        transform: translateX(0);
      }
    }
  `;
}
