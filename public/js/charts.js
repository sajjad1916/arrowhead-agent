// Chart.js rendering for dashboard — brand-themed.

const charts = {
  perDayChart: null,

  renderPerDay(perDay) {
    const canvas = document.getElementById('perDayChart');
    if (!canvas || !window.Chart) return;
    const labels = Object.keys(perDay);
    const data = labels.map((k) => perDay[k]);

    // If a previous chart exists but its canvas was detached from the DOM
    // (e.g. the page template was re-rendered), destroy it and start fresh.
    if (this.perDayChart) {
      const existingCanvas = this.perDayChart.canvas;
      const isOrphaned = !existingCanvas || !document.body.contains(existingCanvas);
      if (isOrphaned || existingCanvas !== canvas) {
        try { this.perDayChart.destroy(); } catch (_) {}
        this.perDayChart = null;
      } else {
        this.perDayChart.data.labels = labels.map(formatShortDate);
        this.perDayChart.data.datasets[0].data = data;
        this.perDayChart.update();
        return;
      }
    }

    // Gradient fill — brand red fading down
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, '#ED1B2F');
    grad.addColorStop(1, 'rgba(237, 27, 47, 0.55)');

    this.perDayChart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels.map(formatShortDate),
        datasets: [{
          label: 'Tickets',
          data,
          backgroundColor: grad,
          borderRadius: 4,
          borderSkipped: false,
          barThickness: 'flex',
          maxBarThickness: 48,
          hoverBackgroundColor: '#BF1525',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 700,
          easing: 'easeOutQuart',
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#2E2E2E',
            titleFont: { family: 'Source Sans 3', size: 11, weight: '700' },
            bodyFont: { family: 'Open Sans', size: 12 },
            padding: 10,
            cornerRadius: 4,
            displayColors: false,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              precision: 0,
              color: '#8E8E8E',
              font: { family: 'Source Sans 3', size: 11 },
            },
            grid: { color: '#E4E0DA', drawTicks: false },
            border: { display: false },
          },
          x: {
            ticks: {
              color: '#8E8E8E',
              font: { family: 'Source Sans 3', size: 11, weight: '600' },
            },
            grid: { display: false },
            border: { display: false },
          },
        },
      },
    });
  },
};

function formatShortDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

window.charts = charts;
