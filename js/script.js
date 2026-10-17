const menuToggle = document.getElementById('menuToggle');
const navLinks = document.getElementById('navLinks');

// Open and close the mobile navigation.
menuToggle.addEventListener('click', function () {
  const opened = navLinks.classList.toggle('open');
  menuToggle.classList.toggle('open', opened);
  menuToggle.setAttribute('aria-expanded', String(opened));
});

// Close the menu after selecting a navigation link.
document.querySelectorAll('.nav-link').forEach(function (link) {
  link.addEventListener('click', function () {
    navLinks.classList.remove('open');
    menuToggle.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
  });
});

// Reveal sections gently when they enter the screen.
const revealItems = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(function (entries, currentObserver) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        currentObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  revealItems.forEach(function (item) { observer.observe(item); });
} else {
  revealItems.forEach(function (item) { item.classList.add('visible'); });
}

// Set the copyright year automatically.
document.getElementById('year').textContent = new Date().getFullYear();

// Update the active navigation link as the user scrolls.
const sections = document.querySelectorAll('main section[id]');
const links = document.querySelectorAll('.nav-link');
window.addEventListener('scroll', function () {
  let active = 'home';
  sections.forEach(function (section) {
    if (window.scrollY >= section.offsetTop - 150) active = section.id;
  });
  links.forEach(function (link) {
    link.classList.toggle('active', link.getAttribute('href') === '#' + active);
  });
}, { passive: true });

// Header shadow and back-to-top button, updated on scroll.
const header = document.querySelector('.header');
const toTop = document.getElementById('toTop');

function onScroll() {
  const y = window.scrollY || window.pageYOffset;
  if (header) header.classList.toggle('scrolled', y > 12);
  if (toTop) toTop.classList.toggle('show', y > 420);
}

window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

if (toTop) {
  toTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Search and category filtering for the services catalog.
(function () {
  const searchInput = document.getElementById('serviceSearch');
  const catalog = document.getElementById('serviceCatalog');
  if (!searchInput || !catalog) return;

  const categories = Array.prototype.slice.call(catalog.querySelectorAll('.service-category'));
  const noResults = document.getElementById('noResults');
  const countLabel = document.getElementById('serviceCount');
  const pillBar = document.getElementById('serviceFilters');
  const pills = pillBar ? Array.prototype.slice.call(pillBar.querySelectorAll('.filter-pill')) : [];
  const totalServices = catalog.querySelectorAll('.service-item').length;
  let activeCategory = 'all';

  function runFilter() {
    const term = searchInput.value.trim().toLowerCase();
    let visible = 0;

    categories.forEach(function (category) {
      const categoryAllowed = activeCategory === 'all' || category.dataset.category === activeCategory;
      let shown = 0;

      Array.prototype.forEach.call(category.querySelectorAll('.service-item'), function (item) {
        const nameEl = item.querySelector('.service-name');
        const name = (nameEl ? nameEl.textContent : item.textContent).toLowerCase();
        const matches = categoryAllowed && (term === '' || name.indexOf(term) !== -1);
        item.classList.toggle('is-hidden', !matches);
        if (matches) shown += 1;
      });

      category.classList.toggle('is-hidden', shown === 0);
      visible += shown;
    });

    if (noResults) noResults.hidden = visible !== 0;
    if (countLabel) {
      countLabel.textContent = 'Showing ' + visible + ' of ' + totalServices + ' services';
    }
  }

  searchInput.addEventListener('input', runFilter);

  pills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      activeCategory = pill.dataset.filter;
      pills.forEach(function (other) { other.classList.toggle('active', other === pill); });
      runFilter();
    });
  });

  runFilter();
})();
