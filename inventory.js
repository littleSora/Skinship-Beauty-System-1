// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD2Yh7L4Wl9XRlOgxnzZyo8xxds6a02UJY",
  authDomain: "skinship-1ff4b.firebaseapp.com",
  projectId: "skinship-1ff4b",
  storageBucket: "skinship-1ff4b.appspot.com",
  messagingSenderId: "963752770497",
  appId: "1:963752770497:web:8911cc6a375acdbdcc8d40"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// Global variables
let inventoryData = [];
let currentCategoryFilter = 'all';
let currentStatusFilter = 'all';
let editMode = false;
let categories = [];
let currentUser = null;
let inventoryListener = null;
let purchaseOrderListener = null;
let sessionMonitor = null;
let pendingDeleteCategoryName = null;
let pendingDeleteCategoryItemCount = 0;
let userDataCache = null;
let categoriesCache = null;
let lastCategoriesFetch = 0;
const CACHE_DURATION = 300000; // 5 minutes

// ==================== OVERSTOCK CALCULATION ====================

function calculateOverstock(currentStock, originalOrderQty, customThreshold = null) {
  if (!originalOrderQty || originalOrderQty <= 0) {
    return {
      isOverstock: false,
      excessUnits: 0,
      overstockThreshold: 0
    };
  }
  
  // Use custom threshold if provided, otherwise 20% of original order
  const threshold = customThreshold !== null ? customThreshold : Math.ceil(originalOrderQty * 0.20);
  
  // Calculate excess units above threshold
  const excessUnits = currentStock - (originalOrderQty + threshold);
  
  // Overstock if current stock exceeds original order + threshold
  const isOverstock = currentStock > (originalOrderQty + threshold);
  
  return {
    isOverstock: isOverstock,
    excessUnits: Math.max(0, excessUnits),
    overstockThreshold: threshold,
    originalOrderQty: originalOrderQty
  };
}

// Toast notification function
function showToast(message, type = 'info') {
  // Create container if it doesn't exist
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    `;
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = `toast-notification ${type}`;
  
  const icons = {
    error: 'fa-circle-xmark',
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };
  
  const colors = {
    error: '#dc2626',
    success: '#16a34a',
    warning: '#f59e0b',
    info: '#3b82f6'
  };
  
  toast.style.cssText = `
    background: white;
    border-left: 4px solid ${colors[type]};
    border-radius: 8px;
    padding: 16px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: flex;
    gap: 12px;
    align-items: flex-start;
    animation: slideIn 0.3s ease;
    max-width: 100%;
  `;
  
  toast.innerHTML = `
    <div style="color: ${colors[type]}; font-size: 20px; flex-shrink: 0;">
      <i class="fa-solid ${icons[type]}"></i>
    </div>
    <div style="flex: 1; font-size: 14px; color: #374151;">
      <p style="margin: 0;">${message}</p>
    </div>
    <button onclick="this.parentElement.remove()" style="background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 18px; padding: 0; flex-shrink: 0;">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;
  
  container.appendChild(toast);
  
  // Auto remove after 5 seconds
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// Add animation styles
if (!document.getElementById('toastStyles')) {
  const style = document.createElement('style');
  style.id = 'toastStyles';
  style.textContent = `
    @keyframes slideIn {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }
  `;
  document.head.appendChild(style);
}

// Session monitoring function
function setupSessionMonitoring(userId) {
  if (sessionMonitor) sessionMonitor(); // Cleanup previous listener
  
  const userRef = db.collection('users').doc(userId);
  const storedSessionId = sessionStorage.getItem('sessionId');
  
  if (!storedSessionId) {
    console.warn('No session ID found, logging out...');
    auth.signOut();
    return;
  }
  
  sessionMonitor = userRef.onSnapshot((snapshot) => {
    if (!snapshot.exists) {
      console.warn('User document no longer exists');
      auth.signOut();
      return;
    }
    
    const data = snapshot.data();
    const currentSessionId = data.currentSessionId;
    
    // Check if session ID has changed (another login or password change)
    if (currentSessionId && currentSessionId !== storedSessionId) {
      console.log('Session invalidated - another login detected or password changed');
      
      // Show notification before logout
// Show notification before logout
showToast('Your session has been ended because someone else logged into this account or your password was changed', 'error');

// Force logout after a short delay to show the toast
setTimeout(() => {
  auth.signOut().then(() => {
    window.location.href = 'index.html';
  });
}, 2000); // 2 second delay to ensure user sees the toast
    }
  }, (error) => {
    console.error('Session monitoring error:', error);
  });
}

async function loadCurrentUserName() {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      try {
        // Check cache first
        if (userDataCache && userDataCache.uid === user.uid) {
          currentUser = userDataCache;
          document.getElementById('userDisplayName').textContent = currentUser.fullName;
          document.getElementById('logoutUsername').textContent = currentUser.fullName;
          
          // Setup session monitoring
          setupSessionMonitoring(user.uid);
          return;
        }

        const userDoc = await db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          currentUser = {
            uid: user.uid,
            fullName: userData.fullName || userData.email || 'User',
            email: userData.email || user.email
          };
        } else {
          currentUser = {
            uid: user.uid,
            fullName: user.email || 'User',
            email: user.email
          };
        }

        // Cache user data
        userDataCache = currentUser;
        
        document.getElementById('userDisplayName').textContent = currentUser.fullName;
        document.getElementById('logoutUsername').textContent = currentUser.fullName;
        
        // Setup session monitoring
        setupSessionMonitoring(user.uid);
      } catch (error) {
        console.error('Error loading user data:', error);
        currentUser = {
          uid: user.uid,
          fullName: user.email || 'User',
          email: user.email
        };
        userDataCache = currentUser;
        document.getElementById('userDisplayName').textContent = currentUser.fullName;
        document.getElementById('logoutUsername').textContent = currentUser.fullName;
      }
    } else {
      window.location.href = 'index.html';
    }
  });
}

// Load categories from Firebase
async function loadCategoriesFromFirebase() {
  try {
    // Check cache first
    if (categoriesCache) {
      categories = categoriesCache;
      return;
    }

    const doc = await db.collection('metadata').doc('inventoryCategories').get();
    if (doc.exists && doc.data().list) {
      categories = doc.data().list.map(name => ({ id: name, name: name }));
    } else {
      // If no categories exist, extract from inventory items
      const categorySet = new Set();
      inventoryData.forEach(item => {
        if (item.category) {
          categorySet.add(item.category);
        }
      });
      
      if (categorySet.size === 0) {
        const defaultCategories = ['Hair Products', 'Nail Products', 'Skincare', 'Lash Products', 'Tools'];
        categories = defaultCategories.map(cat => ({ id: cat, name: cat }));
      } else {
        categories = Array.from(categorySet).map(cat => ({ id: cat, name: cat }));
      }
      
      // Save to Firebase for future use
      const categoryNames = categories.map(c => c.name);
      await db.collection('metadata').doc('inventoryCategories').set({ list: categoryNames });
    }
    
    // Cache categories
    categoriesCache = categories;
  } catch (error) {
    console.error('Error loading categories:', error);
    const defaultCategories = ['Hair Products', 'Nail Products', 'Skincare', 'Lash Products', 'Tools'];
    categories = defaultCategories.map(cat => ({ id: cat, name: cat }));
    categoriesCache = categories;
  }
}

// Save categories to Firebase
async function saveCategoriesToFirebase() {
  try {
    const categoryNames = categories.map(c => c.name);
    await db.collection('metadata').doc('inventoryCategories').set({ list: categoryNames });
    categoriesCache = categories;
  } catch (error) {
    console.error('Error saving categories:', error);
  }
}

// Clock out function - OPTIMIZED with batch write
async function handleClockOut() {
  const user = auth.currentUser;
  if (!user) return;
  
  try {
    const today = new Date().toLocaleDateString();
    const logsRef = db.collection('staffLogs').doc(user.uid).collection('history');
    
    const todayQuery = logsRef.where('date', '==', today).limit(1);
    const todaySnap = await todayQuery.get();
    
    if (!todaySnap.empty) {
      const activeLog = todaySnap.docs[0];
      if (!activeLog.data().clockOut) {
        const batch = db.batch();
        
        batch.update(logsRef.doc(activeLog.id), {
          clockOut: new Date().toLocaleString()
        });
        
        batch.update(db.collection('users').doc(user.uid), {
          availability: false,
          lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        await batch.commit();
        console.log("User clocked out and set to unavailable");
      }
    }
  } catch (error) {
    console.error("Error during clock out:", error);
  }
}

// Logout modal functions
function showLogoutModal() {
  document.getElementById('logoutModal').classList.add('show');
}

function hideLogoutModal() {
  document.getElementById('logoutModal').classList.remove('show');
}

async function confirmLogout() {
  const confirmBtn = document.getElementById('confirmLogoutBtn');
  confirmBtn.classList.add('loading');
  confirmBtn.innerHTML = '<i class="fa-solid fa-spinner"></i> Logging out...';

  try {
    await handleClockOut();
    
    // Clear caches
    userDataCache = null;
    categoriesCache = null;
    
    // Detach listeners
    if (inventoryListener) inventoryListener();
    if (purchaseOrderListener) purchaseOrderListener();
    if (sessionMonitor) sessionMonitor();
    
    // Clear session storage
    sessionStorage.removeItem('sessionId'); 
    // Clear session storage
    sessionStorage.removeItem('sessionId');
    sessionStorage.removeItem('inventoryNotificationsShown'); // Clear notification flag
    
    await auth.signOut();
    window.location.href = "index.html";
  } catch (error) {
    console.error("Logout error:", error);
    confirmBtn.classList.remove('loading');
    confirmBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Logout';
showToast("An error occurred during logout. Please try again.", 'error');
    
    // Force logout anyway
    sessionStorage.removeItem('sessionId'); 
    await auth.signOut();
    window.location.href = "index.html";
  }
}


async function loadCategories() {
  try {
    // Load categories from Firebase first
    await loadCategoriesFromFirebase();
    
    // Merge with categories from inventory items
    const categorySet = new Set();
    inventoryData.forEach(product => {
      if (product.category) {
        categorySet.add(product.category);
      }
    });

    // Add any new categories from inventory that aren't in the saved list
    categorySet.forEach(cat => {
      if (!categories.find(c => c.name === cat)) {
        categories.push({ id: cat, name: cat });
      }
    });

    // Sort categories alphabetically
    categories.sort((a, b) => a.name.localeCompare(b.name));

    categoriesCache = categories;
    lastCategoriesFetch = Date.now();

    updateCategorySelects();
  } catch (error) {
    console.error('Error loading categories:', error);
  }
}

// Update all category select elements
function updateCategorySelects() {
  const categorySelects = [
    document.getElementById('itemCategory'),
    document.getElementById('editItemCategory'),
    document.getElementById('categoryFilter')
  ];

  categorySelects.forEach((select, index) => {
    if (!select) return;
    
    const currentValue = select.value;
    
    if (index === 2) {
      select.innerHTML = '<option value="all">All Categories</option>';
    } else {
      select.innerHTML = '<option value="">Select Category</option>';
    }
    
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat.name;
      option.textContent = cat.name;
      select.appendChild(option);
    });
    
    if (index !== 2) {
      const addOption = document.createElement('option');
      addOption.value = '__ADD_NEW__';
      addOption.textContent = '+ Add New Category';
      addOption.style.fontWeight = 'bold';
      addOption.style.color = '#da5c73';
      select.appendChild(addOption);
      
      const manageOption = document.createElement('option');
      manageOption.value = '__MANAGE__';
      manageOption.textContent = '⚙️ Manage Categories';
      manageOption.style.fontWeight = 'bold';
      manageOption.style.color = '#da5c73';
      select.appendChild(manageOption);
    }
    
    if (currentValue && currentValue !== 'all' && currentValue !== '' && 
        currentValue !== '__ADD_NEW__' && currentValue !== '__MANAGE__') {
      select.value = currentValue;
    }
  });
  
  const addCategorySelects = [
    document.getElementById('itemCategory'),
    document.getElementById('editItemCategory')
  ];
  
  addCategorySelects.forEach(select => {
    if (!select) return;
    select.removeEventListener('change', handleCategorySelectChange);
    select.addEventListener('change', handleCategorySelectChange);
  });
}

// Handle category select change
function handleCategorySelectChange(event) {
  if (event.target.value === '__ADD_NEW__') {
    event.target.dataset.triggerSelect = 'true';
    openAddCategoryModal();
    setTimeout(() => {
      event.target.value = '';
    }, 100);
  } else if (event.target.value === '__MANAGE__') {
    openManageCategoriesModal();
    setTimeout(() => {
      event.target.value = '';
    }, 100);
  }
}

// Open/Close Add Category Modal
function openAddCategoryModal() {
  document.getElementById('addCategoryModal').classList.add('show');
}

function closeAddCategoryModal() {
  document.getElementById('addCategoryModal').classList.remove('show');
  document.getElementById('addCategoryForm').reset();
}

// Handle Add Category
async function handleAddCategory(event) {
  event.preventDefault();
  
  const categoryName = document.getElementById('newCategoryName').value.trim();
  
if (!categoryName) {
  showToast('Category name cannot be empty!', 'error');
  return;
}
  
if (categories.some(cat => cat.name.toLowerCase() === categoryName.toLowerCase())) {
  showToast('This category already exists! Please choose a different name.', 'error');
  return;
}
  
  try {
    // Add to categories array
    categories.push({
      id: categoryName,
      name: categoryName
    });
    
    // Sort categories alphabetically
    categories.sort((a, b) => a.name.localeCompare(b.name));
    
    // Save to Firebase
    await saveCategoriesToFirebase();
    
    // Update the dropdown
    updateCategorySelects();
    closeAddCategoryModal();
    
    const addSelect = document.getElementById('itemCategory');
    const editSelect = document.getElementById('editItemCategory');
    const addModal = document.getElementById('addProductModal');
    const editModal = document.getElementById('editProductModal');
    
    if (addModal && addModal.classList.contains('show')) {
      addSelect.value = categoryName;
    } else if (editModal && editModal.classList.contains('show')) {
      editSelect.value = categoryName;
    }
    
showToast(`Category "${categoryName}" added successfully! You can now add products to this category.`, 'success');
    
} catch (error) {
  console.error('Error adding category:', error);
  showToast('Error adding category. Please try again.', 'error');
}
}

// Open/Close Manage Categories Modal
function openManageCategoriesModal() {
  document.getElementById('manageCategoriesModal').classList.add('show');
  loadManageCategoriesList();
}

function closeManageCategoriesModal() {
  document.getElementById('manageCategoriesModal').classList.remove('show');
}

// Load categories list for management
function loadManageCategoriesList() {
  const listContainer = document.getElementById('manageCategoriesList');
  
  if (categories.length === 0) {
    listContainer.innerHTML = '<p class="text-gray-500 text-center py-4">No categories found.</p>';
    return;
  }
  
  listContainer.innerHTML = '';
  
  categories.forEach(cat => {
    const categoryItem = document.createElement('div');
    categoryItem.className = 'flex justify-between items-center p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition';
    
    const itemCount = inventoryData.filter(i => i.category === cat.name).length;

categoryItem.innerHTML = `
  <div>
    <span class="font-semibold text-gray-800">${cat.name || 'Unnamed Category'}</span>
    <span class="text-sm text-gray-500 ml-2">(${itemCount} item${itemCount !== 1 ? 's' : ''})</span>
  </div>
  <button 
    onclick="handleDeleteCategory('${encodeURIComponent(cat.name || '')}', ${itemCount})" 
    class="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 transition text-sm"
    title="Delete category"
  >
    <i class="fa-solid fa-trash"></i> Delete
  </button>
`;
    
    listContainer.appendChild(categoryItem);
  });
}

async function handleDeleteCategory(categoryName, itemCount) {
  // Decode the category name if it was encoded
  const decodedCategoryName = decodeURIComponent(categoryName);
  
  pendingDeleteCategoryName = decodedCategoryName;
  pendingDeleteCategoryItemCount = itemCount;
  
  showDeleteCategoryModal(decodedCategoryName, itemCount);
}

function showDeleteCategoryModal(categoryName, itemCount) {
  const deleteModal = document.createElement('div');
  deleteModal.className = 'modal-overlay show';
  deleteModal.id = 'deleteCategoryModal';
  
  const warningText = itemCount === 0 
    ? 'This action cannot be undone' 
    : 'All items in this category will also be deleted';
  
  deleteModal.innerHTML = `
    <div class="logout-modal" style="max-width: 500px;">
      <div class="logout-modal-header">
        <div class="logout-icon" style="background: linear-gradient(135deg, #fecaca 0%, #dc2626 100%);">
          <i class="fa-solid fa-trash"></i>
        </div>
        <h2>Confirm Delete Category</h2>
        <p>Are you sure you want to delete "${categoryName}"?</p>
      </div>

      <div class="logout-modal-body">
        <div class="logout-info-item">
          <i class="fa-solid fa-exclamation-triangle" style="color: #dc2626;"></i>
          <span>${warningText}</span>
        </div>
        <div class="logout-info-item">
          <i class="fa-solid fa-layer-group"></i>
          <span>${categoryName}</span>
        </div>
        ${itemCount > 0 ? `
        <div class="logout-info-item">
          <i class="fa-solid fa-box"></i>
          <span>${itemCount} item${itemCount !== 1 ? 's' : ''} will be deleted</span>
        </div>
        ` : ''}
      </div>

      <div class="logout-modal-actions">
        <button class="logout-btn logout-btn-cancel" onclick="hideDeleteCategoryModal()">
          <i class="fa-solid fa-xmark"></i>
          Cancel
        </button>
        <button class="logout-btn logout-btn-confirm" style="background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);" id="confirmDeleteCategoryBtn" onclick="confirmDeleteCategory()">
          <i class="fa-solid fa-trash"></i>
          Delete Category
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(deleteModal);
  
  deleteModal.addEventListener('click', function(e) {
    if (e.target === deleteModal) {
      hideDeleteCategoryModal();
    }
  });
}

function hideDeleteCategoryModal() {
  const modal = document.getElementById('deleteCategoryModal');
  if (modal) {
    modal.remove();
  }
  pendingDeleteCategoryName = null;
  pendingDeleteCategoryItemCount = 0;
}

async function confirmDeleteCategory() {
  const confirmBtn = document.getElementById('confirmDeleteCategoryBtn');
  confirmBtn.classList.add('loading');
  confirmBtn.innerHTML = '<i class="fa-solid fa-spinner"></i> Deleting...';
  
  // Safety check
  if (!pendingDeleteCategoryName || pendingDeleteCategoryName === 'null') {
    showToast('Invalid category name. Please try again.', 'error');
    hideDeleteCategoryModal();
    return;
  }
  
  const itemsInCategory = inventoryData.filter(i => i.category === pendingDeleteCategoryName);

  try {
    const batches = [];
    let currentBatch = db.batch();
    let operationCount = 0;
    
    itemsInCategory.forEach(item => {
      currentBatch.delete(db.collection('inventory').doc(item.firebaseId));
      operationCount++;
      
      if (operationCount === 500) {
        batches.push(currentBatch);
        currentBatch = db.batch();
        operationCount = 0;
      }
    });
    
    if (operationCount > 0) {
      batches.push(currentBatch);
    }
    
    await Promise.all(batches.map(batch => batch.commit()));
    
    inventoryData = inventoryData.filter(i => i.category !== pendingDeleteCategoryName);
    categories = categories.filter(c => c.name !== pendingDeleteCategoryName);
    
    await saveCategoriesToFirebase();
    
    updateStats();
    updateCategorySelects();
    loadManageCategoriesList();
    updateSidebarBubbles();
    
    hideDeleteCategoryModal();
    showToast(`Category "${pendingDeleteCategoryName}" and its ${itemsInCategory.length} item(s) have been deleted successfully!`, 'success');
  } catch (error) {
    console.error('Error deleting category:', error);
    showToast('Error deleting category. Please try again.', 'error');
    hideDeleteCategoryModal();
  }
}

// Search functionality - debounced
let searchTimeout;
document.getElementById('searchInput').addEventListener('input', function(e) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const searchTerm = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#inventoryTableBody tr');
    
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(searchTerm) ? '' : 'none';
    });
  }, 300);
});


function filterByStatus(status) {
  const buttons = document.querySelectorAll('.filter-btn');
  buttons.forEach(btn => {
    if(btn.textContent.includes('All Items') || btn.textContent.includes('In Stock') || 
       btn.textContent.includes('Low Stock') || btn.textContent.includes('Out of Stock') ||
       btn.textContent.includes('Overstock')) {
      btn.classList.remove('active');
    }
  });
  event.target.classList.add('active');
  
  // Store current status filter
  currentStatusFilter = status;
  
  const rows = document.querySelectorAll('#inventoryTableBody tr');
  let visibleCount = 0;
  
  rows.forEach(row => {
    const rowStatus = row.getAttribute('data-status');
    const rowCategory = row.getAttribute('data-category');
    const qty = parseInt(row.getAttribute('data-qty')) || 0;
    const minStock = parseInt(row.getAttribute('data-min-stock')) || 10;
    const isOverstock = qty > (minStock * 1.5) && qty > 0;
    
    let statusMatch = false;
    let categoryMatch = false;
    
    // Check status filter
    if(status === 'all') {
      statusMatch = true;
} else if(status === 'overstock') {
  statusMatch = rowStatus === 'overstock';
    } else if(status === 'in-stock') {
      statusMatch = rowStatus === 'in-stock';
    } else {
      statusMatch = rowStatus === status;
    }
    
    // Check category filter
    if(currentCategoryFilter === 'all') {
      categoryMatch = true;
    } else {
      categoryMatch = rowCategory === currentCategoryFilter;
    }
    
    // Show row only if both filters match
    const shouldShow = statusMatch && categoryMatch;
    row.style.display = shouldShow ? '' : 'none';
    if (shouldShow) visibleCount++;
  });
  
  // Show "no products" message if no visible products
  const tbody = document.getElementById('inventoryTableBody');
  const existingMessage = tbody.querySelector('.no-products-message');
  
  if (visibleCount === 0 && inventoryData.length > 0) {
    if (existingMessage) existingMessage.remove();
    
    const statusText = status === 'overstock' ? 'Overstock' : 
                       status === 'in-stock' ? 'In Stock' :
                       status === 'low-stock' ? 'Low Stock' :
                       status === 'out-of-stock' ? 'Out of Stock' : '';
    
    const messageRow = document.createElement('tr');
    messageRow.className = 'no-products-message';
    messageRow.innerHTML = `
      <td colspan="8" class="text-center py-8">
        <i class="fa-solid fa-filter-circle-xmark text-4xl text-gray-400 mb-3 block"></i>
        <strong class="text-gray-600">No products with "${statusText}" status</strong>
        <br>
        <span class="text-sm text-gray-500">Try selecting a different filter</span>
      </td>
    `;
    tbody.appendChild(messageRow);
  } else if (existingMessage) {
    existingMessage.remove();
  }
}

function filterByCategory() {
  const category = document.getElementById('categoryFilter').value;
  
  // Store current category filter
  currentCategoryFilter = category;
  
  const rows = document.querySelectorAll('#inventoryTableBody tr');
  let visibleCount = 0;
  
  rows.forEach(row => {
    const rowCategory = row.getAttribute('data-category');
    const rowStatus = row.getAttribute('data-status');
    const qty = parseInt(row.getAttribute('data-qty')) || 0;
    const minStock = parseInt(row.getAttribute('data-min-stock')) || 10;
    const isOverstock = qty > (minStock * 1.5) && qty > 0;
    
    let categoryMatch = false;
    let statusMatch = false;
    
    // Check category filter
    if(category === 'all') {
      categoryMatch = true;
    } else {
      categoryMatch = rowCategory === category;
    }
    
    // Check status filter
    if(currentStatusFilter === 'all') {
      statusMatch = true;
} else if(currentStatusFilter === 'overstock') {
  statusMatch = rowStatus === 'overstock';
    } else if(currentStatusFilter === 'in-stock') {
      statusMatch = rowStatus === 'in-stock';
    } else {
      statusMatch = rowStatus === currentStatusFilter;
    }
    
    // Show row only if both filters match
    const shouldShow = categoryMatch && statusMatch;
    row.style.display = shouldShow ? '' : 'none';
    if (shouldShow) visibleCount++;
  });
  
  // Show "no products" message if category has no products
  const tbody = document.getElementById('inventoryTableBody');
  const existingMessage = tbody.querySelector('.no-products-message');
  
  if (visibleCount === 0 && category !== 'all' && inventoryData.length > 0) {
    // Remove existing message if any
    if (existingMessage) existingMessage.remove();
    
    // Add "no products in category" message
    const messageRow = document.createElement('tr');
    messageRow.className = 'no-products-message';
    messageRow.innerHTML = `
      <td colspan="8" class="text-center py-8">
        <i class="fa-solid fa-box-open text-4xl text-gray-400 mb-3 block"></i>
        <strong class="text-gray-600">No products found in "${category}" category</strong>
        <br>
        <span class="text-sm text-gray-500">Begin Purchasing an order to add products to this category</span>
      </td>
    `;
    tbody.appendChild(messageRow);
  } else if (existingMessage) {
    existingMessage.remove();
  }
}

// Export to CSV
function exportToCSV() {
  let csv = 'Item ID,Item Name,Category,Quantity,Unit Price,Total Value,Last Updated,Status,Last Edited By\n';
  
  inventoryData.forEach(row => {
    csv += `${row.id},${row.name},${row.category},${row.qty},${row.price},${row.total},${row.date},${row.status},${row.lastEditedBy || row.createdBy || 'Unknown'}\n`;
  });
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inventory_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  window.URL.revokeObjectURL(url);
}

// Close dropdown when clicking outside
document.addEventListener('click', function(event) {
  const userMenu = document.getElementById('userMenu');
  const userMenuButton = document.getElementById('userMenuButton');
  
  if (userMenuButton && !userMenuButton.contains(event.target) && !userMenu.contains(event.target)) {
    userMenu.classList.add('hidden');
  }

  const logoutModal = document.getElementById('logoutModal');
  if (logoutModal && event.target === logoutModal) {
    hideLogoutModal();
  }
});

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('logoutModal');
    if (modal && modal.classList.contains('show')) {
      hideLogoutModal();
    }
  }
});

// Update sidebar bubbles based on inventory status - NO FIREBASE READS
function updateSidebarBubbles() {
  const noStockCount = inventoryData.filter(item => item.status === 'out-of-stock').length;
  const lowStockCount = inventoryData.filter(item => item.status === 'low-stock').length;
  const overstockCount = inventoryData.filter(item => item.status === 'overstock').length;
  
  // Update inventory bubble (no stock - red, low stock - yellow, overstock - blue)
  updateInventoryBubble(noStockCount, lowStockCount, overstockCount);
  
  // Check if notifications have already been shown in this session
  const notificationsShown = sessionStorage.getItem('inventoryNotificationsShown');
  
  if (!notificationsShown) {
    // Show toast for critical inventory issues (only once per session)
    if (noStockCount > 0) {
      showToast(`⚠️ ${noStockCount} product${noStockCount > 1 ? 's are' : ' is'} out of stock!`, 'error');
    } else if (lowStockCount > 0) {
      showToast(`⚠️ ${lowStockCount} product${lowStockCount > 1 ? 's are' : ' is'} running low on stock`, 'warning');
    } else if (overstockCount > 0) {
      showToast(`ℹ️ ${overstockCount} product${overstockCount > 1 ? 's have' : ' has'} excess inventory`, 'info');
    }
    
    // Mark notifications as shown for this session
    sessionStorage.setItem('inventoryNotificationsShown', 'true');
  }
}

function updateInventoryBubble(noStock, lowStock, overstock) {
  const button = document.querySelector('button[title="Inventory"]');
  if (!button) return;
  
  let bubble = button.querySelector('.sidebar-bubble');
  
  if (!bubble) {
    bubble = document.createElement('span');
    bubble.className = 'sidebar-bubble';
    button.style.position = 'relative';
    button.appendChild(bubble);
  }
  
  if (noStock > 0) {
    bubble.textContent = noStock > 99 ? '99+' : noStock;
    bubble.style.backgroundColor = '#dc2626'; // Red
    bubble.style.display = 'flex';
  } else if (lowStock > 0) {
    bubble.textContent = lowStock > 99 ? '99+' : lowStock;
    bubble.style.backgroundColor = '#f59e0b'; // Yellow
    bubble.style.display = 'flex';
  } else if (overstock > 0) {
    bubble.textContent = overstock > 99 ? '99+' : overstock;
    bubble.style.backgroundColor = '#3b82f6'; // Blue
    bubble.style.display = 'flex';
  } else {
    bubble.style.display = 'none';
  }
}

// Monitor purchase orders for sidebar bubble - OPTIMIZED single listener
function monitorPurchaseOrders() {
  if (purchaseOrderListener) {
    purchaseOrderListener();
  }

  purchaseOrderListener = db.collection('purchaseOrders')
    .where('status', '==', 'pending')
    .limit(100)
    .onSnapshot((snapshot) => {
      const newOrderCount = snapshot.size;
      updatePurchaseOrderBubble(newOrderCount);
    }, (error) => {
      console.error('Error monitoring purchase orders:', error);
    });
}

function updatePurchaseOrderBubble(count) {
  const button = document.querySelector('button[title="Purchase Order"]');
  if (!button) return;
  
  let bubble = button.querySelector('.sidebar-bubble');
  
  if (!bubble) {
    bubble = document.createElement('span');
    bubble.className = 'sidebar-bubble';
    button.style.position = 'relative';
    button.appendChild(bubble);
  }
  
  if (count > 0) {
    bubble.textContent = count > 99 ? '99+' : count;
    bubble.style.backgroundColor = '#8b5cf6'; // Purple
    bubble.style.display = 'flex';
  } else {
    bubble.style.display = 'none';
  }
}

// Generate next Item ID
function generateItemId() {
  const maxId = inventoryData.reduce((max, item) => {
    const num = parseInt(item.id.split('-')[1]);
    return num > max ? num : max;
  }, 0);
  return `INV-${String(maxId + 1).padStart(3, '0')}`;
}

// Get current date
function getCurrentDate() {
  const today = new Date();
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  return today.toLocaleDateString('en-US', options);
}

function determineStatus(qty, minStock, originalOrderQty = 0, customThreshold = null) {
  if (qty === 0) return 'out-of-stock';
  if (qty <= minStock) return 'low-stock';
  
  // Check for overstock using purchase order quantity
  if (originalOrderQty > 0) {
    const overstockCalc = calculateOverstock(qty, originalOrderQty, customThreshold);
    if (overstockCalc.isOverstock) return 'overstock';
  }
  
  return 'in-stock';
}

// Open Add Product Modal
function openAddProductModal() {
  updateCategorySelects();
  document.getElementById('addProductModal').classList.add('show');
}

// Close Add Product Modal
function closeAddProductModal() {
  document.getElementById('addProductModal').classList.remove('show');
  document.getElementById('addProductForm').reset();
}

// Generate sequential unique ID
let itemCounterCache = null;
let lastCounterFetch = 0;
const COUNTER_CACHE_DURATION = 60000;

async function generateUniqueItemId() {
  try {
    const now = Date.now();
    
    if (itemCounterCache !== null && (now - lastCounterFetch) < COUNTER_CACHE_DURATION) {
      itemCounterCache++;
      db.collection('metadata').doc('inventoryCounter').update({ last: itemCounterCache }).catch(() => {});
      return `INV-${String(itemCounterCache).padStart(3, '0')}`;
    }
    
    const counterRef = db.collection('metadata').doc('inventoryCounter');
    let newNumber = 1;

    await db.runTransaction(async (tx) => {
      const docSnap = await tx.get(counterRef);
      if (docSnap.exists) {
        newNumber = (docSnap.data().last || 0) + 1;
        tx.update(counterRef, { last: newNumber });
      } else {
        tx.set(counterRef, { last: 1 });
        newNumber = 1;
      }
    });

    itemCounterCache = newNumber;
    lastCounterFetch = now;

    return `INV-${String(newNumber).padStart(3, '0')}`;
  } catch (error) {
    console.error('Error generating ID:', error);
    return `INV-${Date.now().toString().slice(-3)}`;
  }
}

// Handle Add Product Form Submission
async function handleAddProduct(event) {
  event.preventDefault();
  
  const name = document.getElementById('itemName').value.trim();
  const category = document.getElementById('itemCategory').value;
  const qty = parseInt(document.getElementById('itemQuantity').value);
  const price = parseFloat(document.getElementById('itemPrice').value);
  const minStock = parseInt(document.getElementById('minStock').value);
  const supplier = document.getElementById('itemSupplier').value.trim();
  const description = document.getElementById('itemDescription').value.trim();
  
if (!category || category === '__ADD_NEW__' || category === '__MANAGE__') {
  showToast('Please select a valid category', 'error');
  return;
}

  const categoryExists = categories.some(cat => cat.name.toLowerCase() === category.toLowerCase());
  
if (!categoryExists) {
  showToast('The selected category does not exist in the database. Please select an existing category or create a new one.', 'error');
  return;
}
  
  const total = qty * price;
  const status = determineStatus(qty, minStock);
  
  const newProduct = {
    id: await generateUniqueItemId(),
    name: name,
    category: category,
    qty: qty,
    price: price,
    total: total,
    date: getCurrentDate(),
    status: status,
    minStock: minStock,
    supplier: supplier,
    description: description,
    createdBy: currentUser ? currentUser.fullName : 'Unknown',
    createdDate: getCurrentDate(),
    lastEditedBy: currentUser ? currentUser.fullName : 'Unknown'
  };
  
  try {
    const docRef = await db.collection('inventory').add(newProduct);
    newProduct.firebaseId = docRef.id;
    
closeAddProductModal();
showToast(`Product "${name}" added successfully!`, 'success');
} catch (error) {
  console.error('Error adding product:', error);
  showToast('Error adding product. Please try again.', 'error');
}
}

// Toggle Edit Mode
function enableEditMode() {
  editMode = !editMode;
  const rows = document.querySelectorAll('#inventoryTableBody tr');
  const editBtn = document.getElementById('editModeBtn');

  if (editMode) {
    editBtn.classList.add('active');
    editBtn.innerHTML = '<i class="fa-solid fa-xmark mr-2"></i>Cancel Edit';
    rows.forEach(row => {
      row.classList.add('edit-mode-active');
      row.addEventListener('click', selectRowForEdit);
    });
  } else {
    editBtn.classList.remove('active');
    editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square mr-2"></i>Edit Item';
    rows.forEach(row => {
      row.classList.remove('edit-mode-active');
      row.removeEventListener('click', selectRowForEdit);
    });
  }
}

// When a row is clicked in edit mode
function selectRowForEdit(event) {
  if (!editMode) return;
  
  if (event.target.closest('td:nth-child(7)')) return;

  const idCell = this.querySelector('td').textContent.trim();
const product = inventoryData.find(p => p.id === idCell);
if (!product) {
  showToast('Product not found.', 'error');
  return;
}

  updateCategorySelects();
  
setTimeout(() => {
  document.getElementById('editFirebaseId').value = product.firebaseId;
  document.getElementById('editItemName').value = product.name;
  document.getElementById('editItemCategory').value = product.category;
  document.getElementById('editItemQuantity').value = product.qty;
  document.getElementById('editItemPrice').value = product.price;
  document.getElementById('editMinStock').value = product.minStock || 0;
  document.getElementById('editItemSupplier').value = product.supplier || '';
  document.getElementById('editItemDescription').value = product.description || '';
  document.getElementById('editOriginalOrderQty').value = product.originalOrderQty || 0;
  document.getElementById('editOverstockThreshold').value = product.overstockThreshold || (product.originalOrderQty ? Math.ceil(product.originalOrderQty * 0.20) : 0);
  
  // Load restock history
  loadRestockHistory(product.restockHistory || []);

  document.getElementById('editProductModal').classList.add('show');
}, 100);
}
// Load and display restock history
function loadRestockHistory(history) {
  const container = document.getElementById('restockHistoryContainer');
  
  if (!history || history.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm">No restock history available</p>';
    return;
  }
  
  // Sort by date (newest first)
  const sortedHistory = [...history].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  container.innerHTML = sortedHistory.map(entry => `
    <div class="bg-white rounded p-3 mb-2 border-l-4 border-blue-500">
      <div class="flex justify-between items-start mb-1">
        <span class="font-semibold text-sm text-gray-800">
          <i class="fa-solid fa-box mr-1"></i>+${entry.quantity} units
        </span>
        <span class="text-xs text-gray-500">${entry.date}</span>
      </div>
      ${entry.purchaseOrderId ? `<div class="text-xs text-gray-600"><i class="fa-solid fa-file-invoice mr-1"></i>PO: ${entry.purchaseOrderId}</div>` : ''}
      ${entry.addedBy ? `<div class="text-xs text-gray-600"><i class="fa-solid fa-user mr-1"></i>By: ${entry.addedBy}</div>` : ''}
      ${entry.notes ? `<div class="text-xs text-gray-500 mt-1 italic">${entry.notes}</div>` : ''}
    </div>
  `).join('');
}

// Close Edit Product Modal
function closeEditProductModal() {
  document.getElementById('editProductModal').classList.remove('show');
  if (editMode) enableEditMode();
}

// Save edited product
async function handleEditProduct(e) {
  e.preventDefault();

  const id = document.getElementById('editFirebaseId').value;
  const category = document.getElementById('editItemCategory').value;
  
if (!category || category === '__ADD_NEW__' || category === '__MANAGE__') {
  showToast('Please select a valid category', 'error');
  return;
}

  const categoryExists = categories.some(cat => cat.name.toLowerCase() === category.toLowerCase());
  
if (!categoryExists) {
  showToast('The selected category does not exist in the database. Please select an existing category or create a new one.', 'error');
  return;
}
  
  const qty = parseInt(document.getElementById('editItemQuantity').value);
  const price = parseFloat(document.getElementById('editItemPrice').value);
  const minStock = parseInt(document.getElementById('editMinStock').value);
  const status = determineStatus(qty, minStock);
  const total = qty * price;
  
const originalOrderQty = parseInt(document.getElementById('editOriginalOrderQty').value) || 0;
const customThreshold = parseInt(document.getElementById('editOverstockThreshold').value) || null;
const newStatus = determineStatus(qty, minStock, originalOrderQty, customThreshold);

const updatedProduct = {
  name: document.getElementById('editItemName').value.trim(),
  category: category,
  qty: qty,
  price: price,
  minStock: minStock,
  supplier: document.getElementById('editItemSupplier').value.trim(),
  description: document.getElementById('editItemDescription').value.trim(),
  total: total,
  status: newStatus,
  date: getCurrentDate(),
  lastEditedBy: currentUser ? currentUser.fullName : 'Unknown',
  originalOrderQty: originalOrderQty,
  overstockThreshold: customThreshold
};

  try {
    if (id) {
await db.collection('inventory').doc(id).update(updatedProduct);
closeEditProductModal();
showToast('✅ Product updated successfully!', 'success');
} else {
  showToast('Error: Missing Firestore document ID.', 'error');
}
    
} catch (error) {
  console.error('Error updating product:', error);
  showToast('Error updating product. Check console for details.', 'error');
}
}

// Show edit history modal
async function showEditHistory(firebaseId) {
  const product = inventoryData.find(p => p.firebaseId === firebaseId);
  if (!product) return;

  const modal = document.getElementById('editHistoryModal');
  const modalBody = document.getElementById('editHistoryBody');
  
  modalBody.innerHTML = `
    <h2 class="text-2xl font-bold text-[#da5c73] mb-4">
      <i class="fa-solid fa-history mr-2"></i>Edit History
    </h2>
    <div class="space-y-3">
      <div><strong>Item Name:</strong> ${product.name}</div>
      <div><strong>Item ID:</strong> ${product.id}</div>
      <div><strong>Last Updated:</strong> ${product.date || 'N/A'}</div>
      <div><strong>Last Edited By:</strong> ${product.lastEditedBy || 'Unknown'}</div>
      ${product.createdBy ? `<div><strong>Created By:</strong> ${product.createdBy}</div>` : ''}
      ${product.createdDate ? `<div><strong>Created On:</strong> ${product.createdDate}</div>` : ''}
    </div>
    <div class="mt-6">
      <button onclick="closeEditHistoryModal()" class="w-full bg-[#da5c73] text-white px-4 py-2 rounded hover:bg-[#c54d63]">
        <i class="fa-solid fa-times mr-2"></i>Close
      </button>
    </div>
  `;
  
  modal.classList.add('show');
}

function closeEditHistoryModal() {
  document.getElementById('editHistoryModal').classList.remove('show');
}

// Update statistics - calculate from in-memory data
function updateStats() {
  const totalItems = inventoryData.length;
  const totalValue = inventoryData.reduce((sum, item) => sum + item.total, 0);
  const inStock = inventoryData.filter(item => item.status === 'in-stock').length;
  const lowStock = inventoryData.filter(item => item.status === 'low-stock').length;
  const outOfStock = inventoryData.filter(item => item.status === 'out-of-stock').length;
  const overstock = inventoryData.filter(item => item.status === 'overstock').length;
  
  document.getElementById('totalItems').textContent = totalItems;
  document.getElementById('totalValue').textContent = `₱ ${totalValue.toLocaleString()}`;
  
  const inStockElement = document.getElementById('inStock');
  if (inStockElement) {
    inStockElement.textContent = inStock;
  }
  
  document.getElementById('lowStock').textContent = lowStock;
  document.getElementById('outOfStock').textContent = outOfStock;
  
  const overstockElement = document.getElementById('overstock');
  if (overstockElement) {
    overstockElement.textContent = overstock;
  }
}

// Render table from in-memory data
function renderInventoryTable() {
  const tbody = document.getElementById('inventoryTableBody');
  
  if (inventoryData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-gray-500">No inventory items found. Click "Add Item" to get started.</td></tr>';
    return;
  }
  
  const fragment = document.createDocumentFragment();
  
  inventoryData.forEach(product => {
    const row = document.createElement('tr');
    row.className = 'border-b hover:bg-gray-50 transition';
    row.setAttribute('data-status', product.status || 'in-stock');
    row.setAttribute('data-category', product.category || '');
    row.setAttribute('data-firebase-id', product.firebaseId);
    row.setAttribute('data-qty', product.qty || 0);
    row.setAttribute('data-min-stock', product.minStock || 10);
    
    let statusBadge = '';
    if (product.status === 'overstock') {
      statusBadge = '<span class="px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-600">Overstock</span>';
    } else if (product.status === 'in-stock') {
      statusBadge = '<span class="px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-600">In Stock</span>';
    } else if (product.status === 'low-stock') {
      statusBadge = '<span class="px-3 py-1 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-600">Low Stock</span>';
    } else {
      statusBadge = '<span class="px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-600">Out of Stock</span>';
    }
    
    const price = product.price || 0;
    const total = product.total || 0;
    const qty = product.qty || 0;
    
    row.innerHTML = `
      <td class="py-4 px-4 font-semibold">${product.id || 'N/A'}</td>
      <td class="py-4 px-4">${product.name || 'N/A'}</td>
      <td class="py-4 px-4">${product.category || 'N/A'}</td>
      <td class="py-4 px-4 text-center">${qty}</td>
      <td class="py-4 px-4 text-right">₱ ${price.toLocaleString()}</td>
      <td class="py-4 px-4 text-right font-semibold text-[#da5c73]">₱ ${total.toLocaleString()}</td>
      <td class="py-4 px-4 text-center text-sm cursor-pointer hover:text-[#da5c73] hover:underline" onclick="showEditHistory('${product.firebaseId}')" title="Click to see edit history">${product.date || 'N/A'}</td>
      <td class="py-4 px-4 text-center">${statusBadge}</td>
    `;
    
    fragment.appendChild(row);
  });
  
  tbody.innerHTML = '';
  tbody.appendChild(fragment);
  
  // Reapply current filters after rendering
  if (currentCategoryFilter !== 'all' || currentStatusFilter !== 'all') {
    const rows = document.querySelectorAll('#inventoryTableBody tr');
  rows.forEach(row => {
  const rowCategory = row.getAttribute('data-category');
  const rowStatus = row.getAttribute('data-status');
  
  let categoryMatch = currentCategoryFilter === 'all' || rowCategory === currentCategoryFilter;
  
  let statusMatch = false;
  if(currentStatusFilter === 'all') {
    statusMatch = true;
  } else if(currentStatusFilter === 'overstock') {
    statusMatch = rowStatus === 'overstock';
  } else if(currentStatusFilter === 'in-stock') {
    statusMatch = rowStatus === 'in-stock';
  } else {
    statusMatch = rowStatus === currentStatusFilter;
  }
  
  row.style.display = (categoryMatch && statusMatch) ? '' : 'none';
});
  }
}

// Load inventory from Firebase - OPTIMIZED with real-time listener
function loadInventoryFromFirebase() {
  try {
    inventoryListener = db.collection('inventory')
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const product = change.doc.data();
          product.firebaseId = change.doc.id;
          
// Recalculate status and total when document changes
const qty = product.qty || 0;
const price = product.price || 0;
const minStock = product.minStock || 10;
const originalOrderQty = product.originalOrderQty || 0;
const customThreshold = product.overstockThreshold || null;

// Update status based on current quantity with overstock logic
product.status = determineStatus(qty, minStock, originalOrderQty, customThreshold);
          
          // Recalculate total
          product.total = qty * price;
          
          // Update date if not already set to today
          const today = getCurrentDate();
          if (!product.date || product.date !== today) {
            product.date = today;
          }
          
          if (change.type === 'added') {
            const exists = inventoryData.find(p => p.firebaseId === product.firebaseId);
            if (!exists) {
              inventoryData.push(product);
            }
          } else if (change.type === 'modified') {
            const index = inventoryData.findIndex(p => p.firebaseId === product.firebaseId);
            if (index !== -1) {
              inventoryData[index] = product;
              
              // Update Firebase with recalculated values if they changed
              const needsUpdate = 
                inventoryData[index].status !== change.doc.data().status ||
                inventoryData[index].total !== change.doc.data().total ||
                inventoryData[index].date !== change.doc.data().date;
              
              if (needsUpdate) {
                db.collection('inventory').doc(product.firebaseId).update({
                  status: product.status,
                  total: product.total,
                  date: product.date
                }).catch(err => console.error('Error updating calculated fields:', err));
              }
            }
          } else if (change.type === 'removed') {
            const index = inventoryData.findIndex(p => p.firebaseId === product.firebaseId);
            if (index !== -1) {
              inventoryData.splice(index, 1);
            }
          }
        });
        
        renderInventoryTable();
        updateStats();
        updateSidebarBubbles();
        loadCategories();
        
      }, (error) => {
        console.error('Error loading inventory:', error);
        const tbody = document.getElementById('inventoryTableBody');
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-red-500">Error loading inventory. Please refresh the page.</td></tr>';
      });
    
  } catch (error) {
    console.error('Error setting up inventory listener:', error);
    const tbody = document.getElementById('inventoryTableBody');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-red-500">Error loading inventory. Please refresh the page.</td></tr>';
  }
}

// Global variables for delete confirmation
let pendingDeleteProductId = null;
let pendingDeleteProductName = null;

async function deleteProduct() {
  const id = document.getElementById('editFirebaseId').value;
  const productName = document.getElementById('editItemName').value;
  
  // Show delete confirmation modal
  showDeleteProductModal(productName, id);
}

function showDeleteProductModal(productName, productId) {
  pendingDeleteProductId = productId;
  pendingDeleteProductName = productName;
  
  // Create modal
  const deleteModal = document.createElement('div');
  deleteModal.className = 'modal-overlay show';
  deleteModal.id = 'deleteProductModal';
  deleteModal.innerHTML = `
    <div class="logout-modal" style="max-width: 500px;">
      <div class="logout-modal-header">
        <div class="logout-icon" style="background: linear-gradient(135deg, #fecaca 0%, #dc2626 100%);">
          <i class="fa-solid fa-trash"></i>
        </div>
        <h2>Confirm Delete</h2>
        <p>Are you sure you want to delete this product?</p>
      </div>

      <div class="logout-modal-body">
        <div class="logout-info-item">
          <i class="fa-solid fa-exclamation-triangle" style="color: #dc2626;"></i>
          <span>This action cannot be undone</span>
        </div>
        <div class="logout-info-item">
          <i class="fa-solid fa-box"></i>
          <span id="deleteProductNameDisplay">${productName}</span>
        </div>
      </div>

      <div class="logout-modal-actions">
        <button class="logout-btn logout-btn-cancel" onclick="hideDeleteProductModal()">
          <i class="fa-solid fa-xmark"></i>
          Cancel
        </button>
        <button class="logout-btn logout-btn-confirm" style="background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);" id="confirmDeleteProductBtn" onclick="confirmDeleteProduct()">
          <i class="fa-solid fa-trash"></i>
          Delete Product
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(deleteModal);
  
  // Close on backdrop click
  deleteModal.addEventListener('click', function(e) {
    if (e.target === deleteModal) {
      hideDeleteProductModal();
    }
  });
}

function hideDeleteProductModal() {
  const modal = document.getElementById('deleteProductModal');
  if (modal) {
    modal.remove();
  }
  pendingDeleteProductId = null;
  pendingDeleteProductName = null;
}

async function confirmDeleteProduct() {
  const confirmBtn = document.getElementById('confirmDeleteProductBtn');
  confirmBtn.classList.add('loading');
  confirmBtn.innerHTML = '<i class="fa-solid fa-spinner"></i> Deleting...';
  
try {
    if (pendingDeleteProductId) {
      await db.collection('inventory').doc(pendingDeleteProductId).delete();
      
      hideDeleteProductModal();
      closeEditProductModal();
      showToast(`Product "${pendingDeleteProductName}" deleted successfully!`, 'success');
    } else {
      showToast('Error: Missing product ID.', 'error');
      hideDeleteProductModal();
    }
  } catch (error) {
    console.error('Error deleting product:', error);
    showToast('Error deleting product. Check console for details.', 'error');
    confirmBtn.classList.remove('loading');
    confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Product';
  }
}

// Cleanup function
function cleanup() {
  if (inventoryListener) inventoryListener();
  if (purchaseOrderListener) purchaseOrderListener();
  if (sessionMonitor) sessionMonitor();
  userDataCache = null;
  categoriesCache = null;
  inventoryData = [];
  categories = [];
}

// Handle page unload
window.addEventListener("beforeunload", async (e) => {
  await handleClockOut();
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
  document.getElementById('userDisplayName').textContent = 'Loading...';
  document.getElementById('inventoryTableBody').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-gray-500">Loading inventory data...</td></tr>';

    sessionStorage.removeItem('inventoryNotificationsShown');
  
  loadCurrentUserName();
  await loadCategoriesFromFirebase(); // Load categories first
  loadInventoryFromFirebase();
  monitorPurchaseOrders();

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showLogoutModal();
    });
  }
  
  window.addEventListener('unload', cleanup);
});